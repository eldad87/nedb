var customUtils = require('./customUtils')
  , model = require('./model')
  , async = require('async')
  , Executor = require('./executor')
  , Index = require('./indexes')
  , util = require('util')
  , _ = require('underscore')
  , Persistence = require('./persistence')
  ;


/**
 * Create a new collection
 * @param {String} options.filename Optional, datastore will be in-memory only if not provided
 * @param {Boolean} options.inMemoryOnly Optional, default to false
 * @param {Boolean} options.nodeWebkitAppName Optional, specify the name of your NW app if you want options.filename to be relative to the directory where
 *                                            Node Webkit stores application data such as cookies and local storage (the best place to store data in my opinion)
 * @param {Boolean} options.autoload Optional, defaults to false
 */
function Datastore (options) {
  var filename;

  // Retrocompatibility with v0.6 and before
  if (typeof options === 'string') {
    filename = options;
    this.inMemoryOnly = false;   // Default
  } else {
    options = options || {};
    filename = options.filename;
    this.inMemoryOnly = options.inMemoryOnly || false;
    this.autoload = options.autoload || false;
  }

  // Determine whether in memory or persistent
  if (!filename || typeof filename !== 'string' || filename.length === 0) {
    this.filename = null;
    this.inMemoryOnly = true;
  } else {
    this.filename = filename;
  }

  // Persistence handling
  this.persistence = new Persistence({ db: this, nodeWebkitAppName: options.nodeWebkitAppName });

  // This new executor is ready if we don't use persistence
  // If we do, it will only be ready once loadDatabase is called
  this.executor = new Executor();
  if (this.inMemoryOnly) { this.executor.ready = true; }

  // Indexed by field name, dot notation can be used
  // _id is always indexed and since _ids are generated randomly the underlying
  // binary is always well-balanced
  this.indexes = {};
  this.indexes._id = new Index({ fieldName: '_id', unique: true });
  
  if (this.autoload) { this.loadDatabase(); }
}


/**
 * Load the database from the datafile, and trigger the execution of buffered commands if any
 */
Datastore.prototype.loadDatabase = function () {
  this.executor.push({ this: this.persistence, fn: this.persistence.loadDatabase, arguments: arguments }, true);
};


/**
 * Get an array of all the data in the database
 */
Datastore.prototype.getAllData = function () {
  return this.indexes._id.getAll();
};


/**
 * Reset all currently defined indexes
 */
Datastore.prototype.resetIndexes = function (newData) {
  var self = this;

  Object.keys(this.indexes).forEach(function (i) {
    self.indexes[i].reset(newData);
  });
};


/**
 * Ensure an index is kept for this field. Same parameters as lib/indexes
 * For now this function is synchronous, we need to test how much time it takes
 * We use an async API for consistency with the rest of the code
 * @param {String} options.fieldName
 * @param {Boolean} options.unique
 * @param {Boolean} options.sparse
 * @param {Function} cb Optional callback, signature: err
 */
Datastore.prototype.ensureIndex = function (options, cb) {
  var callback = cb || function () {};

  options = options || {};

  if (!options.fieldName) { return callback({ missingFieldName: true }); }
  if (this.indexes[options.fieldName]) { return callback(null); }

  this.indexes[options.fieldName] = new Index(options);

  try {
    this.indexes[options.fieldName].insert(this.getAllData());
  } catch (e) {
    delete this.indexes[options.fieldName];
    return callback(e);
  }

  this.persistence.persistNewState([{ $$indexCreated: options }], function (err) {
    if (err) { return callback(err); }
    return callback(null);
  });
};


/**
 * Remove an index
 * @param {String} fieldName
 * @param {Function} cb Optional callback, signature: err 
 */
Datastore.prototype.removeIndex = function (fieldName, cb) {
  var callback = cb || function () {};
  
  delete this.indexes[fieldName];
  
  this.persistence.persistNewState([{ $$indexRemoved: fieldName }], function (err) {
    if (err) { return callback(err); }
    return callback(null);
  });  
};


/**
 * Add one or several document(s) to all indexes
 */
Datastore.prototype.addToIndexes = function (doc) {
  var i, failingIndex, error
    , keys = Object.keys(this.indexes)
    ;

  for (i = 0; i < keys.length; i += 1) {
    try {
      this.indexes[keys[i]].insert(doc);
    } catch (e) {
      failingIndex = i;
      error = e;
      break;
    }
  }

  // If an error happened, we need to rollback the insert on all other indexes
  if (error) {
    for (i = 0; i < failingIndex; i += 1) {
      this.indexes[keys[i]].remove(doc);
    }

    throw error;
  }
};


/**
 * Remove one or several document(s) from all indexes
 */
Datastore.prototype.removeFromIndexes = function (doc) {
  var self = this;

  Object.keys(this.indexes).forEach(function (i) {
    self.indexes[i].remove(doc);
  });
};


/**
 * Update one or several documents in all indexes
 * To update multiple documents, oldDoc must be an array of { oldDoc, newDoc } pairs
 * If one update violates a constraint, all changes are rolled back
 */
Datastore.prototype.updateIndexes = function (oldDoc, newDoc) {
  var i, failingIndex, error
    , keys = Object.keys(this.indexes)
    ;

  for (i = 0; i < keys.length; i += 1) {
    try {
      this.indexes[keys[i]].update(oldDoc, newDoc);
    } catch (e) {
      failingIndex = i;
      error = e;
      break;
    }
  }

  // If an error happened, we need to rollback the update on all other indexes
  if (error) {
    for (i = 0; i < failingIndex; i += 1) {
      this.indexes[keys[i]].revertUpdate(oldDoc, newDoc);
    }

    throw error;
  }
};


/**
 * Return the list of candidates for a given query
 * Crude implementation for now, we return the candidates given by the first usable index if any
 * We try the following query types, in this order: basic match, $in match, comparison match
 * One way to make it better would be to enable the use of multiple indexes if the first usable index
 * returns too much data. I may do it in the future.
 */
Datastore.prototype.getCandidates = function (query) {
  var indexNames = Object.keys(this.indexes)
    , usableQueryKeys;

  // For a basic match
  usableQueryKeys = [];
  Object.keys(query).forEach(function (k) {
    if (typeof query[k] === 'string' || typeof query[k] === 'number' || typeof query[k] === 'boolean' || util.isDate(query[k]) || query[k] === null) {
      usableQueryKeys.push(k);
    }
  });
  usableQueryKeys = _.intersection(usableQueryKeys, indexNames);
  if (usableQueryKeys.length > 0) {
    return this.indexes[usableQueryKeys[0]].getMatching(query[usableQueryKeys[0]]);
  }

  // For a $in match
  usableQueryKeys = [];
  Object.keys(query).forEach(function (k) {
    if (query[k] && query[k].hasOwnProperty('$in')) {
      usableQueryKeys.push(k);
    }
  });
  usableQueryKeys = _.intersection(usableQueryKeys, indexNames);
  if (usableQueryKeys.length > 0) {
    return this.indexes[usableQueryKeys[0]].getMatching(query[usableQueryKeys[0]].$in);
  }

  // For a comparison match
  usableQueryKeys = [];
  Object.keys(query).forEach(function (k) {
    if (query[k] && (query[k].hasOwnProperty('$lt') || query[k].hasOwnProperty('$lte') || query[k].hasOwnProperty('$gt') || query[k].hasOwnProperty('$gte'))) {
      usableQueryKeys.push(k);
    }
  });
  usableQueryKeys = _.intersection(usableQueryKeys, indexNames);
  if (usableQueryKeys.length > 0) {
    return this.indexes[usableQueryKeys[0]].getBetweenBounds(query[usableQueryKeys[0]]);
  }

  // By default, return all the DB data
  return this.getAllData();
};


/**
 * Insert a new document
 * @param {Function} cb Optional callback, signature: err, insertedDoc
 *
 * @api private Use Datastore.insert which has the same signature
 */
Datastore.prototype._insert = function (newDoc, cb) {
  var callback = cb || function () {}
    ;

  try {
    this._insertInCache(newDoc);
  } catch (e) {
    return callback(e);
  }

  this.persistence.persistNewState(util.isArray(newDoc) ? newDoc : [newDoc], function (err) {
    if (err) { return callback(err); }
    return callback(null, newDoc);
  });
};

/**
 * Prepare a document (or array of documents) to be inserted in a database
 * @api private
 */
Datastore.prototype.prepareDocumentForInsertion = function (newDoc) {
  var preparedDoc, self = this;

  if (util.isArray(newDoc)) {
    preparedDoc = [];
    newDoc.forEach(function (doc) { preparedDoc.push(self.prepareDocumentForInsertion(doc)); });
  } else {
    newDoc._id = customUtils.uid(16);
    preparedDoc = model.deepCopy(newDoc);
    model.checkObject(preparedDoc);
  }
  
  return preparedDoc;
};

/**
 * If newDoc is an array of documents, this will insert all documents in the cache
 * @api private
 */
Datastore.prototype._insertInCache = function (newDoc) {
  if (util.isArray(newDoc)) {
    this._insertMultipleDocsInCache(newDoc);
  } else {
    this.addToIndexes(this.prepareDocumentForInsertion(newDoc));  
  }
};

/**
 * If one insertion fails (e.g. because of a unique constraint), roll back all previous
 * inserts and throws the error
 * @api private
 */
Datastore.prototype._insertMultipleDocsInCache = function (newDocs) {
  var i, failingI, error
    , preparedDocs = this.prepareDocumentForInsertion(newDocs)
    ;
  
  for (i = 0; i < preparedDocs.length; i += 1) {
    try {
      this.addToIndexes(preparedDocs[i]);
    } catch (e) {
      error = e;
      failingI = i;
      break;
    }
  }
  
  if (error) {
    for (i = 0; i < failingI; i += 1) {
      this.removeFromIndexes(preparedDocs[i]);
    }
    
    throw error;
  }
};

Datastore.prototype.insert = function () {
  this.executor.push({ this: this, fn: this._insert, arguments: arguments });
};

/**
 * Count all documents matching the query
 * @param {Object} query MongoDB-style query
 *
 * @api private Use count
 */
Datastore.prototype._count = function(query, callback) {
  var res = 0
    , self = this
    , candidates = this.getCandidates(query)
    , i
    ;

  try {
    for (i = 0; i < candidates.length; i += 1) {
      if (model.match(candidates[i], query)) {
        res++;
      }
    }
  } catch (err) {
    return callback(err);
  }

  return callback(null, res);
}

Datastore.prototype.count = function() {
    this.executor.push({this: this, fn: this._count, arguments: arguments });
}

/**
 * Find all documents matching the query
 * @param {Object} query MongoDB-style query
 *
 * @api private Use find
 */
Datastore.prototype._find = function (query, callback) {
  var res = []
    , self = this
    , candidates = this.getCandidates(query)
    , i
    ;

  try {
    for (i = 0; i < candidates.length; i += 1) {
      if (model.match(candidates[i], query)) {
        res.push(model.deepCopy(candidates[i]));
      }
    }
  } catch (err) {
    return callback(err);
  }

  return callback(null, this.__aggregate(res, true));
};

Datastore.prototype.find = function () {
  this.executor.push({ this: this, fn: this._find, arguments: arguments });
};


/**
 * Find one document matching the query
 * @param {Object} query MongoDB-style query
 *
 * @api private Use findOne
 */
Datastore.prototype._findOne = function (query, callback) {
  var self = this
    , candidates = this.getCandidates(query)
    , i, found = null
    ;

    candidates = this.__aggregate(candidates);

  try {
    for (i = 0; i < candidates.length; i += 1) {
      if (model.match(candidates[i], query)) {
        found = model.deepCopy(candidates[i]);
      }
    }
  } catch (err) {
    return callback(err);
  }

  return callback(null, found);
};

Datastore.prototype.findOne = function () {
  this.executor.push({ this: this, fn: this._findOne, arguments: arguments });
};


/**
 * Update all docs matching query
 * For now, very naive implementation (recalculating the whole database)
 * @param {Object} query
 * @param {Object} updateQuery
 * @param {Object} options Optional options
 *                 options.multi If true, can update multiple documents (defaults to false)
 *                 options.upsert If true, document is inserted if the query doesn't match anything
 * @param {Function} cb Optional callback, signature: err, numReplaced, upsert (set to true if the update was in fact an upsert)
 *
 * @api private Use Datastore.update which has the same signature
 */
Datastore.prototype._update = function (query, updateQuery, options, cb) {
  var callback
    , self = this
    , numReplaced = 0
    , multi, upsert
    , i
    ;

  if (typeof options === 'function') { cb = options; options = {}; }
  callback = cb || function () {};
  multi = options.multi !== undefined ? options.multi : false;
  upsert = options.upsert !== undefined ? options.upsert : false;

  async.waterfall([
  function (cb) {   // If upsert option is set, check whether we need to insert the doc
    if (!upsert) { return cb(); }

    self._findOne(query, function (err, doc) {
      if (err) { return callback(err); }
      if (doc) {
        return cb();
      } else {
        // The upserted document is the query (since for now queries have the same structure as
        // documents), modified by the updateQuery
        return self._insert(model.modify(query, updateQuery), function (err) {
          if (err) { return callback(err); }
          return callback(null, 1, true);
        });
      }
    });
  }
  , function () {   // Perform the update
    var modifiedDoc
	  , candidates = self.getCandidates(query)
	  , modifications = []
      , tmpCandidates = []
	  ;

    //Get all matching docs
    try {
        candidates.forEach(function (d) {
            if (model.match(d, query)) {
                tmpCandidates.push(d);
            }
        });
    } catch (err) { return callback(err); }

    candidates = self.__aggregate(tmpCandidates, multi);

	// Preparing update (if an error is thrown here neither the datafile nor
	// the in-memory indexes are affected)
    try {
      for (i = 0; i < candidates.length; i += 1) {
        if (multi || numReplaced === 0) {
          numReplaced += 1;
          modifiedDoc = model.modify(candidates[i], updateQuery);
          modifications.push({ oldDoc: candidates[i], newDoc: modifiedDoc });
        }
      }
    } catch (err) {
      return callback(err);
    }
	
	// Change the docs in memory
	try {
      self.updateIndexes(modifications);
	} catch (err) {
	  return callback(err);
	}

	// Update the datafile
    self.persistence.persistNewState(_.pluck(modifications, 'newDoc'), function (err) {
      if (err) { return callback(err); }
      return callback(null, numReplaced);
    });
  }
  ]);
};
Datastore.prototype.update = function () {
  this.executor.push({ this: this, fn: this._update, arguments: arguments });
};

Datastore.prototype.__aggregate = function (candidates, limitSkipResults) {

    //Apply sort
    var orderBy,
        orderDirection,
        self = this,
        aVal,
        bVal,
        sortObj,
        i;
    if(undefined !== this.sort) {
        candidates = candidates.sort(function(a, b) {
            for(i in self.sort) {
                sortObj = self.sort[i];
                orderBy = Object.keys(sortObj)[0];
                orderDirection = sortObj[orderBy];
                aVal = model.getDotValue(a, orderBy);
                bVal = model.getDotValue(b, orderBy);

                if(undefined !== aVal && undefined !== bVal) {
                    if(aVal > bVal) {
                        return orderDirection;
                    }
                    if(aVal < bVal) {
                        return orderDirection == 1 ? -1 : 1;
                    }
                } else {
                    if(undefined !== aVal) {
                        return orderDirection
                    }
                    if(undefined !== bVal) {
                        return orderDirection == 1 ? -1 : 1;
                    }
                }
            }

            return 0;
        });
    }

    if(!limitSkipResults) {
        return candidates;
    }

    //Apply skip/limit
    return candidates.slice(this.skip, this.limit);
}
Datastore.prototype._aggregate = function (query, cb) {
    var callback = cb || function () {};

    //Validate - cannot accept negative value + set values
    if(query.hasOwnProperty('$skip')) {
        if( undefined !== query['$skip'] && (!_.isNumber(query['$skip']) || query['$skip'] < 0) ) {
            return callback('Invalid $skip value, can be undefined or a positive number');
        }
    }
    if(query.hasOwnProperty('$limit')) {
        if( undefined !== query['$limit'] && (!_.isNumber(query['$limit']) || query['$limit'] < 0) ) {
            return callback('Invalid $limit value, can be undefined or a positive number');
        }
    }
    if(query.hasOwnProperty('$sort') && _.isArray(query['$sort'])) {
        _.forEach(query['$sort'], function(sortBy) {
            var sortKey = Object.keys(sortBy)[0];
            if(sortBy[sortKey] !== -1 && sortBy[sortKey] !== 1) {
                return callback('Sort can have -1 or 1 as sorting');
            }
        });
    }

    if(query.hasOwnProperty('$skip')) {
        this.skip = query['$skip'];
    }
    if(query.hasOwnProperty('$limit')) {
        this.limitFix = query['$limit'];
    }

    //Calc the final limit based on skip
    this.limit = this.limitFix;
    if(undefined !== this.limit && undefined !== this.skip) {
        this.limit += this.skip;
    }

    if(query.hasOwnProperty('$sort')) {
        if(_.isObject(query['$sort'])) {
            this.sort = query['$sort'];
        } else {
            this.sort = [{}];
            this.sort[0][query['$sort']]  = 1; //Default sorting
        }
    }

    if(typeof cb === 'function') {
        cb(null);
    }
};
Datastore.prototype.aggregate = function () {
    this.executor.push({ this: this, fn: this._aggregate, arguments: arguments });
};

/**
 * Remove all docs matching the query
 * For now very naive implementation (similar to update)
 * @param {Object} query
 * @param {Object} options Optional options
 *                 options.multi If true, can update multiple documents (defaults to false)
 * @param {Function} cb Optional callback, signature: err, numRemoved
 *
 * @api private Use Datastore.remove which has the same signature
 */
Datastore.prototype._remove = function (query, options, cb) {
  var callback
    , self = this
    , numRemoved = 0
    , multi
    , removedDocs = []
    , candidates = this.getCandidates(query)
    , tmpCandidates = []
    ;

  if (typeof options === 'function') { cb = options; options = {}; }
  callback = cb || function () {};
  multi = options.multi !== undefined ? options.multi : false;

  //Get all matching docs
  try {
    candidates.forEach(function (d) {
        if (model.match(d, query)) {
            tmpCandidates.push(d);
        }
    });
  } catch (err) { return callback(err); }

  candidates = this.__aggregate(tmpCandidates, multi);

  try {
    candidates.forEach(function (d) {
      if (multi || numRemoved === 0) {
        numRemoved += 1;
        removedDocs.push({ $$deleted: true, _id: d._id });
        self.removeFromIndexes(d);
      }
    });
  } catch (err) { return callback(err); }

  self.persistence.persistNewState(removedDocs, function (err) {
    if (err) { return callback(err); }
    return callback(null, numRemoved);
  });
};
Datastore.prototype.remove = function () {
  this.executor.push({ this: this, fn: this._remove, arguments: arguments });
};


module.exports = Datastore;
