'use strict';
const gdal = require('gdal');
const fs = require('fs');
const mkdirp = require('mkdirp');
const queue = require('queue-async');
const path = require('path');
const util = require('util');
const digest = require('@mapbox/mapnik-omnivore').digest;
const mapnik = require('mapnik');
const spawn = require('child_process').spawn;
const invalid = require('../lib/invalid');
const mapnik_index = mapnik.settings.paths.mapnik_index;
if (!fs.existsSync(mapnik_index)) {
  throw new Error('mapnik-index does not exist at ' + mapnik_index);
}

// disable in production
// gdal.verbose();

module.exports = function(infile, outdirectory, callback) {

  mkdirp(outdirectory, (err) => {
    if (err) return callback(err);

    const geojson_files = [];
    let wgs84;
    let ds_kml;
    let lyr_cnt;
    let full_feature_cnt;

    try {
      wgs84 = gdal.SpatialReference.fromEPSG(4326);
      ds_kml = gdal.open(infile);
      lyr_cnt = ds_kml.layers.count();
      full_feature_cnt = 0;
    }
    catch (err) {
      return callback(new Error(err));
    }

    if (lyr_cnt < 1) {
      ds_kml.close();
      return callback(invalid('KML does not contain any layers.'));
    }

    if (lyr_cnt > module.exports.max_layer_count) {
      ds_kml.close();
      return callback(invalid(util.format('%d layers found. Maximum of %d layers allowed.', lyr_cnt, module.exports.max_layer_count)));
    }

    const duplicate_lyr_msg = layername_count(ds_kml);
    if (duplicate_lyr_msg) {
      ds_kml.close();
      return callback(invalid(duplicate_lyr_msg));
    }

    ds_kml.layers.forEach((lyr_kml) => {
      const feat_cnt = lyr_kml.features.count(true);
      if (feat_cnt === 0) return;

      // strip kml from layer name. features at the root get the KML filename as layer name
      let out_ds;
      let geojson;
      const lyr_name = lyr_kml.name
        .replace(/.kml/g, '')
        .replace(/[ \\/&?]/g, '_')
        .replace(/[^_0-9a-zA-Z.-]/g, '');
      const out_name = path.join(outdirectory, lyr_name + '.geojson');

      try {
        out_ds = gdal.open(out_name, 'w', 'GeoJSON');
        geojson = out_ds.layers.create(lyr_name, wgs84, lyr_kml.geomType);
      }
      catch (err) {
        return callback(new Error(err));
      }

      lyr_kml.features.forEach((kml_feat) => {
        const geom = kml_feat.getGeometry();
        if (!geom) return;
        else {
          if (geom.isEmpty()) return;
        }

        geojson.features.add(kml_feat);
        full_feature_cnt++;
      });

      geojson.flush();
      out_ds.flush();
      out_ds.close();

      // release objects to be able to index
      geojson = null;
      out_ds = null;

      geojson_files.push(out_name);
    });

    ds_kml.close();
    if (full_feature_cnt === 0) {
      return callback(invalid('KML does not contain any valid features'));
    }

    // Create metadata file for original kml source
    const metadatafile = path.join(outdirectory, '/metadata.json');
    digest(infile, (err, metadata) => {
      fs.writeFile(metadatafile, JSON.stringify(metadata), (err) => {
        if (err) throw err;
        createIndices((err) => {
          if (err) throw err;
          archiveOriginal((err) => {
            if (err) throw err;
            return callback();
          });
        });
      });
    });

    // Archive original kml file
    function archiveOriginal(callback) {
      const archivedOriginal = path.join(outdirectory, '/archived.kml');
      const infileContents = fs.readFileSync(infile);

      fs.writeFile(archivedOriginal, infileContents, (err) => {
        if (err) return callback(err);
        return callback();
      });
    }

    // create mapnik index for each geojson layer
    function createIndices(callback) {
      const q = queue();
      geojson_files.forEach((gj) => {
        q.defer(createIndex, gj);
      });

      q.awaitAll((err) => {
        if (err) return callback(err);
        return callback();
      });
    }

    function createIndex(layerfile, callback) {
      // Finally, create an .index file in the output dir (if layer is greater than index_worthy_size).
      // mapnik-index will automatically add ".index" to the end of the original filename
      fs.stat(layerfile, (err, stats) => {
        if (err) return callback(err);

        // check size is warrants creating an index
        if (stats.size >= module.exports.index_worthy_size) {
          let data = '';
          const p = spawn(mapnik_index, [layerfile, '--validate-features'])
            .once('error', callback)
            .on('exit', () => {
              // If error printed to --validate-features log
              if (data.indexOf('Error') !== -1) {
                return callback(data);
              }
              else return callback();
            });

          p.stderr.on('data', (d) => {
            d.toString();
            data += d;
          });
        } else {
          return callback();
        }
      });
    }
  });
};

module.exports.description = 'Convert KML to GeoJSON';

module.exports.criteria = function(filepath, info, callback) {

  if (info.filetype !== 'kml') return callback(null, false);

  callback(null, true);
};

function layername_count(ds) {
  const lyr_name_cnt = {};
  ds.layers.forEach((lyr) => {
    const lyr_name = lyr.name;
    if (lyr_name in lyr_name_cnt) {
      lyr_name_cnt[lyr_name]++;
    } else {
      lyr_name_cnt[lyr_name] = 1;
    }
  });

  let err = '';
  for (const name in lyr_name_cnt) {
    const cnt = lyr_name_cnt[name];
    if (cnt > 1) {
      err += util.format('%s\'%s\' found %d times', err.length > 0 ? ', ' : '', name, cnt);
    }
  }

  return err.length > 0 ? 'Duplicate layer names: ' + err : null;
}

// expose this as ENV option?
module.exports.max_layer_count = 15;
module.exports.index_worthy_size = 10 * 1024 * 1024; // 10 MB
