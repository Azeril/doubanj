var central = require('../../lib/central')
var _ = require('../../lib/utils').lodash
var Batcher = require('batch-stream2')
var mongo = central.mongo

var debug = require('debug')
var log = debug('dbj:toplist:by_tag:log')
var verbose = debug('dbj:toplist:by_tag:verbose')
var error = debug('dbj:toplist:by_tag:error')

// reduce to top 100 subjects
//var reduce = function(tag, vals) {
  //vals = Array.prototype.concat.apply([], vals)
  //vals = vals.sort(function(a, b) {
    //return b.count - a.count
  //}).slice(0, 100)

  //return vals
//}
var noop = function(){}


/**
 * Creae a buffer object that accepts `write` options,
 * but only operates the writing action in batch
 */
function createBatcher(out_collection) {
  var buffer = new Batcher({
    size: 5000,
    timeout: 5000,
    highWaterMark: 2,
    transform: function(items, callback) {
      var ids = _.pluck(items, '_id')
      // bulk remove, then bulk insert
      out_collection.remove({_id: {$in: ids }}, function(err) {
        if (err) {
          console.error(err)
        }
        out_collection.insert(items, { w: -1, continueOnError: true }, function(err) {
          if (err) {
            console.error(err)
          } else {
            log('[%s] %s items saved.', out_collection.collectionName, items.length)
          }
          callback()
        })
      })
    }
  })
  // manual resume
  buffer.resume()
  return buffer
}

/**
 * Save users' top tags in given namespace (book,music,music)
 * and collection status into a new collection for easier
 * aggregation.
 */
function users_by_tag(ns, status, done) {
  done = done || noop

  if (!ns || !status) return done(new Error('Namespace and status needed'))

  var stats_status = status || 'all'
  var out_coll = ['top', ns, status, 'user_by_tag'].join('_')
  var ns_stats = ns + '_stats'
  var field_name = [ns_stats, stats_status, 'top_tags'].join('.')

  var query = { last_synced_status: 'succeed' }
  // 至少总共读过20本书才可能进榜吧
  // e.g. { book_stats.done.total: { $gt: 20 } }
  query[ns + '_stats.n_done'] = { $gt: 20 }

  var fields = {}, queryOpt
  fields[field_name] = 1
  queryOpt = { fields: fields }

  mongo.queue(function(db, next) {
    log('[%s] started...', out_coll)

    var out_collection = db.collection(out_coll)
    var stream = db.collection('user').find(query, queryOpt).stream()
    var buffer = createBatcher(out_collection)

    out_collection.ensureIndex({
      tagname: 1,
      count: 1
    }, { background: true }, noop)

    function callback(err) {
      if (err) {
        error('[%s] failed: ', out_coll, err)
      } else {
        log('[%s] generated.', out_coll)
      }
      next()
      done(err)
    }

    function update_tags_coll(user_id, top_tags){
      var completed = true
      top_tags.forEach(function(item, i) {
        completed = buffer.write({
          _id: user_id + '::' + i,
          tagname: item._id,
          count: item.count
        })
      })
      if (!completed) {
        highWater(stream, buffer)
      }
    }

    stream.on('data', function(doc) {
      if (!doc[ns_stats]) return
      var result = doc[ns_stats][stats_status]
      var top_tags = result && result.top_tags
      if (top_tags) {
        update_tags_coll(doc._id, top_tags)
      }
      // too much unwritten output data, pause
      if (buffer.batch.length > 10000) {
        stream.pause()
      }
    })
    stream.once('end', function() {
      buffer.end()
    })
    stream.once('error', callback)
    buffer.once('end', callback)
  }, 4)
}

function subjects_by_tag(ns, done) {
  done = done || function(){}

  if (!ns) return done(new Error('Namespace needed'))

  var out_coll = ['top', ns, 'by_tag'].join('_')
  // 至少有十个人打分的图书才有可能进入热门榜吧
  var query = { 'raters': { $gt: 10 } }

  mongo.queue(function(db, next) {
    log('[%s] started...', out_coll)

    var out_collection = db.collection(out_coll)
    var stream = db.collection(ns).find(query, { fields: {tags: 1} }).stream()
    var buffer = createBatcher(out_collection)
    var total = 0

    out_collection.ensureIndex({ tagname: 1, count: 1 }, { background: true }, noop)

    function callback(err) {
      if (err) {
        error('[%s] failed: ', out_coll, err)
      } else {
        log('[%s] generated.', out_coll)
      }
      next()
      done(err)
    }

    function update_tags_coll(subject_id, top_tags){
      var completed = true
      top_tags.forEach(function(item, i) {
        total++
        // 豆瓣API返回的 tag 格式为
        // item = { name: 'xxx', title: 'xxx', count: 10 }
        completed = buffer.write({
          _id: subject_id + '::' + i,
          tagname: item.name,
          count: item.count
        })
      })
      if (!completed) {
        highWater(stream, buffer)
      }
    }

    stream.on('data', function(doc) {
      if (!doc.tags) return
      update_tags_coll(doc._id, doc.tags)
    })
    stream.once('end', function() {
      buffer.end()
    })
    stream.once('error', callback)

    buffer.once('end', function() {
      log('[%s] total: %s', out_coll, total)
      callback()
    })
  }, 4)
}

function highWater(stream, buffer) {
  stream.pause()
  buffer.once('drain', function() {
    stream.resume()
  })
}
module.exports = {
  users: users_by_tag,
  subjects: subjects_by_tag,
}
