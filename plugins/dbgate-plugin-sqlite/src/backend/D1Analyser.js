const _ = require('lodash');
const Analyser = require('./Analyser');
const sql = require('./sql');
const {
  D1_SCHEMA_SNAPSHOT_SQL,
  applyD1SnapshotContentHashes,
  buildD1SchemaSnapshot,
} = require('./cloudflare/d1SchemaSnapshot');
const {
  collectD1IndexNames,
  filterD1InternalRows,
  foreignKeyListKey,
  indexInfoKey,
  indexListKey,
  loadD1Pragmas,
  loadMissingD1IndexInfo,
  queryD1Batch,
  sortIndexColumns,
  tableInfoKey,
} = require('./cloudflare/d1SchemaLoader');

/**
 * D1-specific analyser.
 *
 * The inherited SQLite analyser is written for a local file, where one query costs nothing. On D1
 * every query is an HTTPS request, so it would spend `4 + 3 * tables + indexes + views` serial
 * round trips on a single analysis. This class asks for the same information, but plans all
 * queries up front and sends them as D1 batch requests, which brings a full analysis down to two
 * requests for a normally sized database. The standard SQLite snapshot additionally uses
 * table-valued index PRAGMAs, which D1 does not support at all.
 */
class D1Analyser extends Analyser {
  constructor(dbhan, driver, version) {
    super(dbhan, driver, version);
    /** sqlite_master rows, shared by the fast snapshot and the full analysis */
    this.schemaRows = null;
  }

  get client() {
    return this.dbhan.client;
  }

  async _getFastSnapshot() {
    if (!this.schemaRows) {
      const [result] = await queryD1Batch(this.client, [D1_SCHEMA_SNAPSHOT_SQL]);
      this.schemaRows = result?.rows ?? [];
    }
    return buildD1SchemaSnapshot(this.schemaRows);
  }

  async _runAnalysis() {
    // Request 1: the object lists. sqlite_master is skipped when the incremental analysis already
    // loaded it for the modification check.
    const [snapshotResult, objectsResult, triggersResult] = await queryD1Batch(this.client, [
      this.schemaRows ? null : D1_SCHEMA_SNAPSHOT_SQL,
      this.createQuery(sql.objectsConditioned, ['tables', 'views']),
      sql.triggers,
    ]);
    if (snapshotResult) {
      this.schemaRows = snapshotResult.rows ?? [];
    }

    const objects = filterD1InternalRows(objectsResult?.rows ?? []);
    const tables = objects.filter((x) => x.type == 'table');
    const views = objects.filter((x) => x.type == 'view');

    const tableSqls = _.zipObject(
      tables.map((x) => x.name),
      tables.map((x) => x.sql)
    );

    const tableList = tables.map((x) => ({
      pureName: x.name,
      objectId: x.name,
      contentHash: x.sql,
    }));

    const viewList = views.map((x) => ({
      pureName: x.name,
      objectId: x.name,
      contentHash: x.sql,
      createSql: x.sql,
    }));

    const tableNames = this.getRequestedObjectPureNames(
      'tables',
      tables.map((x) => x.name)
    ).filter((name) => tableList.some((x) => x.pureName == name));
    const viewNames = this.getRequestedObjectPureNames(
      'views',
      views.map((x) => x.name)
    ).filter((name) => viewList.some((x) => x.pureName == name));

    // Request 2: all column, foreign key and index PRAGMAs of the requested objects at once.
    const pragmas = await loadD1Pragmas(this.client, {
      tableNames,
      viewNames,
      indexNames: collectD1IndexNames(filterD1InternalRows(this.schemaRows), tableNames),
    });
    await loadMissingD1IndexInfo(this.client, pragmas, tableNames);

    for (const tableName of tableNames) {
      const tableObj = tableList.find((x) => x.pureName == tableName);
      const columnRows = pragmas.get(tableInfoKey(tableName)) ?? [];

      tableObj.columns = columnRows.map((col) => ({
        columnName: col.name,
        dataType: col.type,
        notNull: !!col.notnull,
        defaultValue: col.dflt_value == null ? undefined : col.dflt_value,
        autoIncrement: !!tableSqls[tableName]?.toLowerCase().includes('autoincrement') && !!col.pk,
      }));

      // `pragma index_list` returns the newest index first; sort by name so that repeated
      // analyses (and structure comparisons) see a stable order.
      const indexList = _.sortBy(pragmas.get(indexListKey(tableName)) ?? [], (index) => index.name);
      const indexColumns = (index) =>
        sortIndexColumns(pragmas.get(indexInfoKey(index.name))).map((col) => ({ columnName: col.name }));

      tableObj.indexes = indexList
        .filter((index) => index.origin == 'c')
        .map((index) => ({
          constraintName: index.name,
          isUnique: !!index.unique,
          columns: indexColumns(index),
        }));

      tableObj.uniques = indexList
        .filter((index) => index.origin == 'u')
        .map((index) => ({
          constraintName: index.name,
          columns: indexColumns(index),
        }));

      const pkColumns = columnRows.filter((x) => x.pk).map((col) => ({ columnName: col.name }));
      if (pkColumns.length > 0) {
        tableObj.primaryKey = { columns: pkColumns };
      }

      const fkRows = pragmas.get(foreignKeyListKey(tableName)) ?? [];
      tableObj.foreignKeys = _.values(_.groupBy(fkRows, 'id')).map((fkcols) => {
        const fkcol = fkcols[0];
        return {
          pureName: tableName,
          refTableName: fkcol.table,
          columns: fkcols.map((col) => ({
            columnName: col.from,
            refColumnName: col.to,
          })),
          updateAction: fkcol.on_update,
          deleteAction: fkcol.on_delete,
          constraintName: `FK_${tableName}_${fkcol.id}`,
          constraintType: 'foreignKey',
        };
      });
    }

    for (const viewName of viewNames) {
      const viewObj = viewList.find((x) => x.pureName == viewName);
      viewObj.columns = (pragmas.get(tableInfoKey(viewName)) ?? []).map((col) => ({
        columnName: col.name,
        dataType: col.type,
        notNull: !!col.notnull,
      }));
    }

    const structure = {
      tables: tableList,
      views: viewList,
      triggers: filterD1InternalRows(triggersResult?.rows ?? []),
    };

    return applyD1SnapshotContentHashes(structure, buildD1SchemaSnapshot(this.schemaRows));
  }
}

module.exports = D1Analyser;
