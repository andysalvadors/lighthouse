/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const assert = require('assert');
// @ts-ignore - typed where used.
const parseCacheControl = require('parse-cache-control');
const Audit = require('../audit');
const NetworkRequest = require('../../lib/network-request');
const URL = require('../../lib/url-shim');
const linearInterpolation = require('../../lib/statistics').linearInterpolation;
const i18n = require('../../lib/i18n/i18n.js');

const UIStrings = {
  /** Title of a diagnostic audit that provides detail on the cache policy applies to the page's static assets. Cache refers to browser disk cache, which keeps old versions of network resources around for future use. This is displayed in a list of audit titles that Lighthouse generates. */
  title: 'Uses efficient cache policy on static assets',
  /** Title of a diagnostic audit that provides details on the any page resources that could have been served with more efficient cache policies. Cache refers to browser disk cache, which keeps old versions of network resources around for future use. This imperative title is shown to users when there is a significant amount of assets served with poor cache policies. */
  failureTitle: 'Serve static assets with an efficient cache policy',
  /** Description of a Lighthouse audit that tells the user *why* they need to adopt a long cache lifetime policy. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description:
    'A long cache lifetime can speed up repeat visits to your page. ' +
    '[Learn more](https://developers.google.com/web/tools/lighthouse/audits/cache-policy).',
  /** [ICU Syntax] Label for the audit identifying network resources with inefficient cache values. Clicking this will expand the audit to show the resources. */
  displayValue: `{itemCount, plural,
    =1 {1 resource found}
    other {# resources found}
    }`,
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

// Ignore assets that have very high likelihood of cache hit
const IGNORE_THRESHOLD_IN_PERCENT = 0.925;

class CacheHeaders extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'uses-long-cache-ttl',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      scoreDisplayMode: Audit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['devtoolsLogs', 'traces'],
    };
  }

  /**
   * @return {LH.Audit.ScoreOptions}
   */
  static get defaultOptions() {
    return {
      // 50th and 75th percentiles HTTPArchive -> 50 and 75
      // https://bigquery.cloud.google.com/table/httparchive:lighthouse.2018_04_01_mobile?pli=1
      // see https://www.desmos.com/calculator/8meohdnjbl
      scorePODR: 4 * 1024,
      scoreMedian: 128 * 1024,
    };
  }

  /**
   * Computes the percent likelihood that a return visit will be within the cache lifetime, based on
   * Chrome UMA stats see the note below.
   * @param {number} maxAgeInSeconds
   * @return {number}
   */
  static getCacheHitProbability(maxAgeInSeconds) {
    // This array contains the hand wavy distribution of the age of a resource in hours at the time of
    // cache hit at 0th, 10th, 20th, 30th, etc percentiles. This is used to compute `wastedMs` since there
    // are clearly diminishing returns to cache duration i.e. 6 months is not 2x better than 3 months.
    // Based on UMA stats for HttpCache.StaleEntry.Validated.Age, see https://www.desmos.com/calculator/7v0qh1nzvh
    // Example: a max-age of 12 hours already covers ~50% of cases, doubling to 24 hours covers ~10% more.
    const RESOURCE_AGE_IN_HOURS_DECILES = [0, 0.2, 1, 3, 8, 12, 24, 48, 72, 168, 8760, Infinity];
    assert.ok(RESOURCE_AGE_IN_HOURS_DECILES.length === 12, 'deciles 0-10 and 1 for overflow');

    const maxAgeInHours = maxAgeInSeconds / 3600;
    const upperDecileIndex = RESOURCE_AGE_IN_HOURS_DECILES.findIndex(
      decile => decile >= maxAgeInHours
    );

    // Clip the likelihood between 0 and 1
    if (upperDecileIndex === RESOURCE_AGE_IN_HOURS_DECILES.length - 1) return 1;
    if (upperDecileIndex === 0) return 0;

    // Use the two closest decile points as control points
    const upperDecileValue = RESOURCE_AGE_IN_HOURS_DECILES[upperDecileIndex];
    const lowerDecileValue = RESOURCE_AGE_IN_HOURS_DECILES[upperDecileIndex - 1];
    const upperDecile = upperDecileIndex / 10;
    const lowerDecile = (upperDecileIndex - 1) / 10;

    // Approximate the real likelihood with linear interpolation
    return linearInterpolation(
      lowerDecileValue,
      lowerDecile,
      upperDecileValue,
      upperDecile,
      maxAgeInHours
    );
  }

  /**
   * Computes the user-specified cache lifetime, 0 if explicit no-cache policy is in effect, and null if not
   * user-specified. See https://www.w3.org/Protocols/rfc2616/rfc2616-sec14.html
   *
   * @param {Map<string, string>} headers
   * @param {{'no-cache'?: boolean,'no-store'?: boolean, 'max-age'?: number}} cacheControl Follows the potential settings of cache-control, see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
   * @return {?number}
   */
  static computeCacheLifetimeInSeconds(headers, cacheControl) {
    if (cacheControl) {
      // Cache-Control takes precendence over expires
      if (cacheControl['no-cache'] || cacheControl['no-store']) return 0;
      const maxAge = cacheControl['max-age'];
      if (maxAge !== undefined && Number.isFinite(maxAge)) return Math.max(maxAge, 0);
    } else if ((headers.get('pragma') || '').includes('no-cache')) {
      // The HTTP/1.0 Pragma header can disable caching if cache-control is not set, see https://tools.ietf.org/html/rfc7234#section-5.4
      return 0;
    }

    const expiresHeaders = headers.get('expires');
    if (expiresHeaders) {
      const expires = new Date(expiresHeaders).getTime();
      // Invalid expires values MUST be treated as already expired
      if (!expires) return 0;
      return Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    }

    return null;
  }

  /**
   * Given a network record, returns whether we believe the asset is cacheable, i.e. it was a network
   * request that satisifed the conditions:
   *
   *  1. Has a cacheable status code
   *  2. Has a resource type that corresponds to static assets (image, script, stylesheet, etc).
   *
   * Allowing assets with a query string is debatable, PSI considered them non-cacheable with a similar
   * caveat.
   *
   * TODO: Investigate impact in HTTPArchive, experiment with this policy to see what changes.
   *
   * @param {LH.Artifacts.NetworkRequest} record
   * @return {boolean}
   */
  static isCacheableAsset(record) {
    const CACHEABLE_STATUS_CODES = new Set([200, 203, 206]);

    /** @type {Set<LH.Crdp.Page.ResourceType>} */
    const STATIC_RESOURCE_TYPES = new Set([
      NetworkRequest.TYPES.Font,
      NetworkRequest.TYPES.Image,
      NetworkRequest.TYPES.Media,
      NetworkRequest.TYPES.Script,
      NetworkRequest.TYPES.Stylesheet,
    ]);

    const resourceUrl = record.url;
    return (
      CACHEABLE_STATUS_CODES.has(record.statusCode) &&
      STATIC_RESOURCE_TYPES.has(record.resourceType || 'Other') &&
      !resourceUrl.includes('data:')
    );
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static audit(artifacts, context) {
    const devtoolsLogs = artifacts.devtoolsLogs[Audit.DEFAULT_PASS];
    return artifacts.requestNetworkRecords(devtoolsLogs).then(records => {
      const results = [];
      let queryStringCount = 0;
      let totalWastedBytes = 0;

      for (const record of records) {
        if (!CacheHeaders.isCacheableAsset(record)) continue;

        /** @type {Map<string, string>} */
        const headers = new Map();
        for (const header of record.responseHeaders || []) {
          if (headers.has(header.name.toLowerCase())) {
            const previousHeaderValue = headers.get(header.name.toLowerCase());
            headers.set(header.name.toLowerCase(),
              `${previousHeaderValue}, ${header.value}`);
          } else {
            headers.set(header.name.toLowerCase(), header.value);
          }
        }

        const cacheControl = parseCacheControl(headers.get('cache-control'));
        let cacheLifetimeInSeconds = CacheHeaders.computeCacheLifetimeInSeconds(
          headers,
          cacheControl
        );

        // Ignore assets with an explicit no-cache policy
        if (cacheLifetimeInSeconds === 0) continue;
        cacheLifetimeInSeconds = cacheLifetimeInSeconds || 0;

        const cacheHitProbability = CacheHeaders.getCacheHitProbability(cacheLifetimeInSeconds);
        if (cacheHitProbability > IGNORE_THRESHOLD_IN_PERCENT) continue;

        const url = URL.elideDataURI(record.url);
        const totalBytes = record.transferSize || 0;
        const wastedBytes = (1 - cacheHitProbability) * totalBytes;

        totalWastedBytes += wastedBytes;
        if (url.includes('?')) queryStringCount++;

        results.push({
          url,
          cacheControl,
          cacheLifetimeMs: cacheLifetimeInSeconds * 1000,
          cacheHitProbability,
          totalBytes,
          wastedBytes,
        });
      }

      results.sort(
        (a, b) => a.cacheLifetimeMs - b.cacheLifetimeMs || b.totalBytes - a.totalBytes
      );

      const score = Audit.computeLogNormalScore(
        totalWastedBytes,
        context.options.scorePODR,
        context.options.scoreMedian
      );

      const headings = [
        {key: 'url', itemType: 'url', text: str_(i18n.UIStrings.columnURL)},
        // TODO(i18n): pre-compute localized duration
        {key: 'cacheLifetimeMs', itemType: 'ms', text: str_(i18n.UIStrings.columnCacheTTL),
          displayUnit: 'duration'},
        {key: 'totalBytes', itemType: 'bytes', text: str_(i18n.UIStrings.columnSize),
          displayUnit: 'kb', granularity: 1},
      ];

      const summary = {wastedBytes: totalWastedBytes};
      const details = Audit.makeTableDetails(headings, results, summary);

      return {
        score,
        rawValue: totalWastedBytes,
        displayValue: str_(UIStrings.displayValue, {itemCount: results.length}),
        extendedInfo: {
          value: {
            results,
            queryStringCount,
          },
        },
        details,
      };
    });
  }
}

module.exports = CacheHeaders;
module.exports.UIStrings = UIStrings;