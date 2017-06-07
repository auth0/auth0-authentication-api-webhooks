module.exports =
/******/ (function(modules) { // webpackBootstrap
/******/ 	// The module cache
/******/ 	var installedModules = {};

/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {

/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId])
/******/ 			return installedModules[moduleId].exports;

/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			exports: {},
/******/ 			id: moduleId,
/******/ 			loaded: false
/******/ 		};

/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);

/******/ 		// Flag the module as loaded
/******/ 		module.loaded = true;

/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}


/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;

/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;

/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "/build/";

/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(0);
/******/ })
/************************************************************************/
/******/ ([
/* 0 */
/***/ function(module, exports, __webpack_require__) {

	'use strict';

	var async = __webpack_require__(1);
	var express = __webpack_require__(2);
	var Webtask = __webpack_require__(3);
	var app = express();
	var Request = __webpack_require__(5);
	var memoizer = __webpack_require__(6);
	var NestedError = __webpack_require__(7);

	function lastLogCheckpoint(req, res) {
	  var ctx = req.webtaskContext;
	  var required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'WEBHOOK_URL'];
	  var missing_settings = required_settings.filter(function (setting) {
	    return !ctx.data[setting];
	  });

	  if (missing_settings.length) {
	    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
	  }

	  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
	  req.webtaskContext.storage.get(function (err, data) {
	    if (err && err.output.statusCode !== 404) return res.status(err.code).send(err);

	    var startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

	    // Start the process.
	    async.waterfall([function (callback) {
	      var getLogs = function getLogs(context) {
	        console.log('Logs from: ' + (context.checkpointId || 'Start') + '.');

	        var take = Number.parseInt(ctx.data.BATCH_SIZE);

	        context.logs = context.logs || [];

	        getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, function (err, logs) {
	          if (err) {
	            console.log('Error getting logs from Auth0', err);
	            return callback(new NestedError('Error getting logs from Auth0.', err));
	          }

	          if (logs && logs.length) {
	            logs.forEach(function (l) {
	              return context.logs.push(l);
	            });
	            context.checkpointId = context.logs[context.logs.length - 1]._id;
	          }

	          console.log('Total logs: ' + context.logs.length + '.');
	          return callback(null, context);
	        });
	      };

	      getLogs({ checkpointId: startCheckpointId });
	    }, function (context, callback) {
	      var min_log_level = parseInt(ctx.data.LOG_LEVEL) || 0;
	      var log_matches_level = function log_matches_level(log) {
	        if (logTypes[log.type]) {
	          return logTypes[log.type].level >= min_log_level;
	        }
	        return true;
	      };

	      var types_filter = ctx.data.LOG_TYPES && ctx.data.LOG_TYPES.split(',') || [];
	      var log_matches_types = function log_matches_types(log) {
	        if (!types_filter || !types_filter.length) return true;
	        return log.type && types_filter.indexOf(log.type) >= 0;
	      };

	      context.logs = context.logs.filter(function (l) {
	        return l.type !== 'sapi' && l.type !== 'fapi';
	      }).filter(log_matches_level).filter(log_matches_types);

	      callback(null, context);
	    }, function (context, callback) {
	      if (!context.logs.length) {
	        return callback(null, context);
	      }

	      var url = ctx.data.WEBHOOK_URL;
	      var concurrent_calls = ctx.data.WEBHOOK_CONCURRENT_CALLS || 5;

	      console.log('Sending to \'' + url + '\' with ' + concurrent_calls + ' concurrent calls.');

	      async.eachLimit(context.logs, concurrent_calls, function (log, cb) {
	        Request({
	          method: 'POST',
	          url: url,
	          json: true,
	          body: log
	        }, function (err, res, body) {
	          if (err) {
	            console.log('Error sending request:', err);
	            return cb(new NestedError('Error sending request to webhook.', err));
	          }

	          if (res.statusCode.toString().indexOf('2') !== 0) {
	            console.log('Unexpected response while sending request:', JSON.stringify(res.body));
	            return cb(new Error('Unexpected response from webhook: ' + res.statusCode + " - " + JSON.stringify(res.body)));
	          }

	          cb();
	        });
	      }, function (err) {
	        if (err) {
	          return callback(err);
	        }

	        console.log('Upload complete.');
	        return callback(null, context);
	      });
	    }], function (err, context) {
	      if (err) {
	        console.log('Job failed.');

	        return req.webtaskContext.storage.set({ checkpointId: startCheckpointId }, { force: 1 }, function (error) {
	          if (error) {
	            console.log('Error storing startCheckpoint', error);
	            return res.status(500).send({ error: new NestedError('Error storing startCheckpoint.', error) });
	          }

	          res.status(500).send({
	            error: err
	          });
	        });
	      }

	      console.log('Job complete.');

	      return req.webtaskContext.storage.set({
	        checkpointId: context.checkpointId,
	        totalLogsProcessed: context.logs.length
	      }, { force: 1 }, function (error) {
	        if (error) {
	          console.log('Error storing checkpoint', error);
	          return res.status(500).send({ error: new NestedError('Error storing checkpoint', error) });
	        }

	        res.sendStatus(200);
	      });
	    });
	  });
	}

	var logTypes = {
	  's': {
	    event: 'Success Login',
	    level: 1 // Info
	  },
	  'seacft': {
	    event: 'Success Exchange',
	    level: 1 // Info
	  },
	  'seccft': {
	    event: 'Success Exchange (Client Credentials)',
	    level: 1 // Info
	  },
	  'feacft': {
	    event: 'Failed Exchange',
	    level: 3 // Error
	  },
	  'feccft': {
	    event: 'Failed Exchange (Client Credentials)',
	    level: 3 // Error
	  },
	  'f': {
	    event: 'Failed Login',
	    level: 3 // Error
	  },
	  'w': {
	    event: 'Warnings During Login',
	    level: 2 // Warning
	  },
	  'du': {
	    event: 'Deleted User',
	    level: 1 // Info
	  },
	  'fu': {
	    event: 'Failed Login (invalid email/username)',
	    level: 3 // Error
	  },
	  'fp': {
	    event: 'Failed Login (wrong password)',
	    level: 3 // Error
	  },
	  'fc': {
	    event: 'Failed by Connector',
	    level: 3 // Error
	  },
	  'fco': {
	    event: 'Failed by CORS',
	    level: 3 // Error
	  },
	  'con': {
	    event: 'Connector Online',
	    level: 1 // Info
	  },
	  'coff': {
	    event: 'Connector Offline',
	    level: 3 // Error
	  },
	  'fcpro': {
	    event: 'Failed Connector Provisioning',
	    level: 4 // Critical
	  },
	  'ss': {
	    event: 'Success Signup',
	    level: 1 // Info
	  },
	  'fs': {
	    event: 'Failed Signup',
	    level: 3 // Error
	  },
	  'cs': {
	    event: 'Code Sent',
	    level: 0 // Debug
	  },
	  'cls': {
	    event: 'Code/Link Sent',
	    level: 0 // Debug
	  },
	  'sv': {
	    event: 'Success Verification Email',
	    level: 0 // Debug
	  },
	  'fv': {
	    event: 'Failed Verification Email',
	    level: 0 // Debug
	  },
	  'scp': {
	    event: 'Success Change Password',
	    level: 1 // Info
	  },
	  'fcp': {
	    event: 'Failed Change Password',
	    level: 3 // Error
	  },
	  'sce': {
	    event: 'Success Change Email',
	    level: 1 // Info
	  },
	  'fce': {
	    event: 'Failed Change Email',
	    level: 3 // Error
	  },
	  'scu': {
	    event: 'Success Change Username',
	    level: 1 // Info
	  },
	  'fcu': {
	    event: 'Failed Change Username',
	    level: 3 // Error
	  },
	  'scpn': {
	    event: 'Success Change Phone Number',
	    level: 1 // Info
	  },
	  'fcpn': {
	    event: 'Failed Change Phone Number',
	    level: 3 // Error
	  },
	  'svr': {
	    event: 'Success Verification Email Request',
	    level: 0 // Debug
	  },
	  'fvr': {
	    event: 'Failed Verification Email Request',
	    level: 3 // Error
	  },
	  'scpr': {
	    event: 'Success Change Password Request',
	    level: 0 // Debug
	  },
	  'fcpr': {
	    event: 'Failed Change Password Request',
	    level: 3 // Error
	  },
	  'fn': {
	    event: 'Failed Sending Notification',
	    level: 3 // Error
	  },
	  'sapi': {
	    event: 'API Operation'
	  },
	  'limit_wc': {
	    event: 'Blocked Account',
	    level: 4 // Critical
	  },
	  'limit_ui': {
	    event: 'Too Many Calls to /userinfo',
	    level: 4 // Critical
	  },
	  'api_limit': {
	    event: 'Rate Limit On API',
	    level: 4 // Critical
	  },
	  'sdu': {
	    event: 'Successful User Deletion',
	    level: 1 // Info
	  },
	  'fdu': {
	    event: 'Failed User Deletion',
	    level: 3 // Error
	  },
	  'fapi': {
	    event: 'Failed API Operation',
	    level: 3 // Error
	  },
	  'limit_mu': {
	    event: 'Blocked IP Address',
	    level: 3 // Error
	  },
	  'slo': {
	    event: 'Success Logout',
	    level: 1 // Info
	  },
	  'flo': {
	    event: ' Failed Logout',
	    level: 3 // Error
	  },
	  'sd': {
	    event: 'Success Delegation',
	    level: 1 // Info
	  },
	  'fd': {
	    event: 'Failed Delegation',
	    level: 3 // Error
	  }
	};

	function getPageOfLogsFromAuth0(domain, token, take, from, cb) {
	  var url = 'https://' + domain + '/api/v2/logs';

	  Request({
	    method: 'GET',
	    url: url,
	    json: true,
	    qs: {
	      take: take,
	      from: from,
	      sort: 'date:1',
	      per_page: take
	    },
	    headers: {
	      Authorization: 'Bearer ' + token,
	      Accept: 'application/json'
	    }
	  }, function (err, res, body) {
	    if (err) {
	      console.log('Error getting logs', err);
	      cb(new NestedError('Error getting logs.', err));
	    } else {
	      cb(null, body);
	    }
	  });
	}

	function getLogsFromAuth0(domain, token, take, from, cb) {
	  var accumulator = [];

	  var test = function test() {
	    return take > 0;
	  };

	  var iterator = function iterator(iteratorCb) {
	    var pageTake = take > 100 ? 100 : take;
	    getPageOfLogsFromAuth0(domain, token, pageTake, from, function (err, logs) {
	      if (err) {
	        iteratorCb(err);
	      } else {
	        accumulator = accumulator.concat(logs);
	        if (pageTake === logs.length) {
	          take -= logs.length;
	          from = logs[logs.length - 1]._id;
	        } else {
	          take = 0;
	        }
	        iteratorCb();
	      }
	    });
	  };

	  async.whilst(test, iterator, function (err) {
	    if (err) {
	      cb(err);
	    } else {
	      cb(null, accumulator);
	    }
	  });
	}

	var getTokenCached = memoizer({
	  load: function load(apiUrl, audience, clientId, clientSecret, cb) {
	    Request({
	      method: 'POST',
	      url: apiUrl,
	      json: true,
	      body: {
	        audience: audience,
	        grant_type: 'client_credentials',
	        client_id: clientId,
	        client_secret: clientSecret
	      }
	    }, function (err, res, body) {
	      if (err) {
	        cb(null, err);
	      } else {
	        cb(body.access_token);
	      }
	    });
	  },
	  hash: function hash(apiUrl) {
	    return apiUrl;
	  },
	  max: 100,
	  maxAge: 1000 * 60 * 60
	});

	app.use(function (req, res, next) {
	  var apiUrl = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/oauth/token';
	  var audience = 'https://' + req.webtaskContext.data.AUTH0_DOMAIN + '/api/v2/';
	  var clientId = req.webtaskContext.data.AUTH0_CLIENT_ID;
	  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

	  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
	    if (err) {
	      console.log('Error getting access_token', err);
	      return next(new NestedError('Error getting access_token.', err));
	    }

	    req.access_token = access_token;
	    next();
	  });
	});

	app.get('/', lastLogCheckpoint);
	app.post('/', lastLogCheckpoint);

	module.exports = Webtask.fromExpress(app);

/***/ },
/* 1 */
/***/ function(module, exports) {

	module.exports = require("async");

/***/ },
/* 2 */
/***/ function(module, exports) {

	module.exports = require("express");

/***/ },
/* 3 */
/***/ function(module, exports, __webpack_require__) {

	exports.fromConnect = exports.fromExpress = fromConnect;
	exports.fromHapi = fromHapi;
	exports.fromServer = exports.fromRestify = fromServer;


	// API functions

	function fromConnect (connectFn) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return connectFn(req, res);
	    };
	}

	function fromHapi(server) {
	    var webtaskContext;

	    server.ext('onRequest', function (request, response) {
	        var normalizeRouteRx = createRouteNormalizationRx(request.x_wt.jtn);

	        request.setUrl(request.url.replace(normalizeRouteRx, '/'));
	        request.webtaskContext = webtaskContext;
	    });

	    return function (context, req, res) {
	        var dispatchFn = server._dispatch();

	        webtaskContext = attachStorageHelpers(context);

	        dispatchFn(req, res);
	    };
	}

	function fromServer(httpServer) {
	    return function (context, req, res) {
	        var normalizeRouteRx = createRouteNormalizationRx(req.x_wt.jtn);

	        req.originalUrl = req.url;
	        req.url = req.url.replace(normalizeRouteRx, '/');
	        req.webtaskContext = attachStorageHelpers(context);

	        return httpServer.emit('request', req, res);
	    };
	}


	// Helper functions

	function createRouteNormalizationRx(jtn) {
	    var normalizeRouteBase = '^\/api\/run\/[^\/]+\/';
	    var normalizeNamedRoute = '(?:[^\/\?#]*\/?)?';

	    return new RegExp(
	        normalizeRouteBase + (
	        jtn
	            ?   normalizeNamedRoute
	            :   ''
	    ));
	}

	function attachStorageHelpers(context) {
	    context.read = context.secrets.EXT_STORAGE_URL
	        ?   readFromPath
	        :   readNotAvailable;
	    context.write = context.secrets.EXT_STORAGE_URL
	        ?   writeToPath
	        :   writeNotAvailable;

	    return context;


	    function readNotAvailable(path, options, cb) {
	        var Boom = __webpack_require__(4);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function readFromPath(path, options, cb) {
	        var Boom = __webpack_require__(4);
	        var Request = __webpack_require__(5);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'GET',
	            headers: options.headers || {},
	            qs: { path: path },
	            json: true,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode === 404 && Object.hasOwnProperty.call(options, 'defaultValue')) return cb(null, options.defaultValue);
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null, body);
	        });
	    }

	    function writeNotAvailable(path, data, options, cb) {
	        var Boom = __webpack_require__(4);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        cb(Boom.preconditionFailed('Storage is not available in this context'));
	    }

	    function writeToPath(path, data, options, cb) {
	        var Boom = __webpack_require__(4);
	        var Request = __webpack_require__(5);

	        if (typeof options === 'function') {
	            cb = options;
	            options = {};
	        }

	        Request({
	            uri: context.secrets.EXT_STORAGE_URL,
	            method: 'PUT',
	            headers: options.headers || {},
	            qs: { path: path },
	            body: data,
	        }, function (err, res, body) {
	            if (err) return cb(Boom.wrap(err, 502));
	            if (res.statusCode >= 400) return cb(Boom.create(res.statusCode, body && body.message));

	            cb(null);
	        });
	    }
	}


/***/ },
/* 4 */
/***/ function(module, exports) {

	module.exports = require("boom");

/***/ },
/* 5 */
/***/ function(module, exports) {

	module.exports = require("request");

/***/ },
/* 6 */
/***/ function(module, exports) {

	module.exports = require("lru-memoizer");

/***/ },
/* 7 */
/***/ function(module, exports) {

	module.exports = require("nested-error-stacks");

/***/ }
/******/ ]);