// @ts-check

const _ = require('lodash');
const { CloudflareD1Error, D1_ERROR_KIND } = require('./CloudflareD1Error');

/**
 * Schema loading over the Cloudflare D1 REST API.
 *
 * Every D1 query is an independent HTTPS request, so the analyser is latency bound, not CPU
 * bound: describing a database with the one-statement-per-request approach costs
 * `4 + 3 * tables + indexes + views` serial round trips. The `/raw` endpoint accepts several
 * statements in one `batch` request, so all schema PRAGMAs are collected first and then sent
 * together, which reduces a full analysis to a handful of requests.
 *
 * Only read-only statements may be passed through the helpers below - a failed batch is retried
 * statement by statement, which would repeat side effects of a write.
 */

/**
 * Statements per batch request. D1 does not document a hard limit, so this stays conservative;
 * even large databases then need only a few requests instead of hundreds.
 */
const D1_MAX_BATCH_STATEMENTS = 50;

/** Tables and index names of all user objects, used to plan the PRAGMA batch. */
const D1_INDEX_SOURCE_SQL = `
SELECT type, name, tbl_name AS tableName
FROM sqlite_master
WHERE type IN ('table', 'index')
`;

/** @param {unknown} value */
function isD1InternalName(value) {
  return typeof value == 'string' && value.startsWith('_cf_');
}

/**
 * D1 exposes reserved `_cf_*` objects through sqlite_master, but rejects any attempt to inspect
 * them, so they must never reach the analyser.
 *
 * @param {any[]} rows
 */
function filterD1InternalRows(rows) {
  return (rows ?? []).filter(
    (row) =>
      !isD1InternalName(row.name) &&
      !isD1InternalName(row.pureName) &&
      !isD1InternalName(row.tableName) &&
      !isD1InternalName(row.tbl_name)
  );
}

/** @param {string} value */
function quotePragmaArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * The client splits every statement before sending it, so a trailing semicolon must not turn one
 * batch entry into two - the result list is matched to the request list by position.
 *
 * @param {string} sql
 */
function normalizeBatchStatement(sql) {
  return String(sql)
    .trim()
    .replace(/;+\s*$/, '');
}

/**
 * Executes read-only statements in as few requests as possible and returns one result per input,
 * in input order. `null` entries are not sent and come back as `null`, which lets callers keep a
 * fixed result layout for optional queries.
 *
 * @param {{ query: (sql: string) => Promise<any>, executeStatements: (statements: { sql: string }[]) => Promise<any[]> }} client
 * @param {(string|null|undefined)[]} sqlItems
 * @returns {Promise<any[]>}
 */
async function queryD1Batch(client, sqlItems) {
  const results = new Array(sqlItems.length).fill(null);
  const positions = [];
  const statements = [];

  sqlItems.forEach((sqlItem, position) => {
    if (sqlItem == null) return;
    positions.push(position);
    statements.push(normalizeBatchStatement(sqlItem));
  });

  let target = 0;
  for (const chunk of _.chunk(statements, D1_MAX_BATCH_STATEMENTS)) {
    const chunkResults = await executeReadOnlyChunk(client, chunk);
    for (const chunkResult of chunkResults) {
      results[positions[target]] = chunkResult;
      target++;
    }
  }

  return results;
}

/**
 * @param {{ query: (sql: string) => Promise<any>, executeStatements: (statements: { sql: string }[]) => Promise<any[]> }} client
 * @param {string[]} chunk
 */
async function executeReadOnlyChunk(client, chunk) {
  if (chunk.length == 0) return [];
  if (chunk.length == 1) return [await client.query(chunk[0])];

  try {
    const results = await client.executeStatements(chunk.map((sql) => ({ sql })));
    if (results.length != chunk.length) {
      throw new CloudflareD1Error(`Cloudflare D1 returned ${results.length} results for ${chunk.length} statements`, {
        kind: D1_ERROR_KIND.malformedResponse,
      });
    }
    return results;
  } catch (err) {
    // D1 fails a batch as a whole, so one rejected PRAGMA would otherwise break the whole
    // analysis. Retrying one statement per request is slow but keeps the behaviour of the
    // unbatched loader, including which statement the reported error belongs to.
    const results = [];
    for (const sql of chunk) {
      results.push(await client.query(sql));
    }
    return results;
  }
}

/** @param {string} objectName */
function tableInfoKey(objectName) {
  return `tableInfo:${objectName}`;
}

/** @param {string} tableName */
function foreignKeyListKey(tableName) {
  return `foreignKeyList:${tableName}`;
}

/** @param {string} tableName */
function indexListKey(tableName) {
  return `indexList:${tableName}`;
}

/** @param {string} indexName */
function indexInfoKey(indexName) {
  return `indexInfo:${indexName}`;
}

/**
 * Loads the schema PRAGMAs of the requested objects in batched requests.
 *
 * @param {any} client
 * @param {{ tableNames?: string[], viewNames?: string[], indexNames?: string[] }} request
 * @returns {Promise<Map<string, any[]>>} PRAGMA rows by object key
 */
async function loadD1Pragmas(client, { tableNames = [], viewNames = [], indexNames = [] }) {
  const keys = [];
  const statements = [];

  const add = (key, sql) => {
    keys.push(key);
    statements.push(sql);
  };

  for (const tableName of tableNames) {
    const quoted = quotePragmaArgument(tableName);
    add(tableInfoKey(tableName), `pragma table_info(${quoted})`);
    add(foreignKeyListKey(tableName), `pragma foreign_key_list(${quoted})`);
    add(indexListKey(tableName), `pragma index_list(${quoted})`);
  }
  for (const viewName of viewNames) {
    add(tableInfoKey(viewName), `pragma table_info(${quotePragmaArgument(viewName)})`);
  }
  for (const indexName of indexNames) {
    add(indexInfoKey(indexName), `pragma index_info(${quotePragmaArgument(indexName)})`);
  }

  const results = await queryD1Batch(client, statements);
  const pragmas = new Map();
  results.forEach((result, position) => pragmas.set(keys[position], result?.rows ?? []));
  return pragmas;
}

/**
 * `pragma index_list` is the authoritative index list, while the batch above is planned from
 * sqlite_master. Anything the PRAGMA reports but sqlite_master did not is fetched in one extra
 * batch, so an unexpected index cannot silently lose its columns. Normally this sends nothing.
 *
 * @param {any} client
 * @param {Map<string, any[]>} pragmas
 * @param {string[]} tableNames
 */
async function loadMissingD1IndexInfo(client, pragmas, tableNames) {
  const missing = [];
  for (const tableName of tableNames) {
    for (const index of pragmas.get(indexListKey(tableName)) ?? []) {
      if (index.origin == 'pk') continue;
      if (!index.name || pragmas.has(indexInfoKey(index.name)) || missing.includes(index.name)) continue;
      missing.push(index.name);
    }
  }
  if (missing.length == 0) return;

  const extra = await loadD1Pragmas(client, { indexNames: missing });
  for (const [key, rows] of extra) {
    pragmas.set(key, rows);
  }
}

/**
 * Index column rows in the shape of the `indexcols` query of the local SQLite analyser. D1 does
 * not allow SQLite's table-valued `pragma_index_*` functions used by that query, so the same
 * result is assembled from the plain PRAGMA statement form.
 *
 * @param {any} client
 * @returns {Promise<{ rows: any[], columns: any[] }>}
 */
async function loadD1IndexColumns(client) {
  const [objects] = await queryD1Batch(client, [D1_INDEX_SOURCE_SQL]);
  const schemaRows = filterD1InternalRows(objects?.rows ?? []);
  const tableNames = schemaRows.filter((row) => row.type == 'table').map((row) => row.name);
  const indexNames = collectD1IndexNames(schemaRows, tableNames);

  const pragmas = await loadD1Pragmas(client, { tableNames, indexNames });
  await loadMissingD1IndexInfo(client, pragmas, tableNames);

  const rows = [];
  for (const tableName of tableNames) {
    for (const index of _.sortBy(pragmas.get(indexListKey(tableName)) ?? [], (index) => index.name)) {
      if (index.origin == 'pk') continue;
      for (const indexColumn of sortIndexColumns(pragmas.get(indexInfoKey(index.name)))) {
        rows.push({
          tableName,
          constraintName: index.name,
          isUnique: index.unique,
          columnName: indexColumn.name,
          origin: index.origin,
        });
      }
    }
  }

  return { rows, columns: [] };
}

/**
 * Index names of the given tables, read from sqlite_master. Implicit UNIQUE/PK indexes are listed
 * there as well, so the PRAGMA batch can be planned without first asking for `index_list`.
 *
 * @param {any[]} schemaRows
 * @param {string[]} tableNames
 */
function collectD1IndexNames(schemaRows, tableNames) {
  const tableNameSet = new Set(tableNames);
  return schemaRows
    .filter((row) => row.type == 'index' && tableNameSet.has(row.tableName ?? row.tbl_name))
    .map((row) => row.name)
    .filter((name) => name);
}

/** @param {any[]} [indexInfoRows] */
function sortIndexColumns(indexInfoRows) {
  return [...(indexInfoRows ?? [])].sort((a, b) => a.seqno - b.seqno);
}

module.exports = {
  D1_INDEX_SOURCE_SQL,
  D1_MAX_BATCH_STATEMENTS,
  collectD1IndexNames,
  filterD1InternalRows,
  foreignKeyListKey,
  indexInfoKey,
  indexListKey,
  isD1InternalName,
  loadD1IndexColumns,
  loadD1Pragmas,
  loadMissingD1IndexInfo,
  queryD1Batch,
  quotePragmaArgument,
  sortIndexColumns,
  tableInfoKey,
};
