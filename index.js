const request  = require('superagent');
const async    = require('async');
const express  = require('express');
const Webtask  = require('webtask-tools');
const app      = express();
const Request  = require('superagent');
const memoizer = require('lru-memoizer');

function lastLogCheckpoint(req, res) {
  let ctx               = req.webtaskContext;
  let required_settings = ['AUTH0_DOMAIN', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'WEBHOOK_URL'];
  let missing_settings  = required_settings.filter((setting) => !ctx.data[setting]);

  if (missing_settings.length) {
    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
  }

  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
  req.webtaskContext.storage.get((err, data) => {
    if (err && err.output.statusCode !== 404) return res.status(err.code).send(err);

    let startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

    // Start the process.
    async.waterfall([
      (callback) => {
        const getLogs = (context) => {
          console.log(`Logs from: ${context.checkpointId || 'Start'}.`);

          let take = Number.parseInt(ctx.data.BATCH_SIZE);

          context.logs = context.logs || [];

          getLogsFromAuth0(req.webtaskContext.data.AUTH0_DOMAIN, req.access_token, take, context.checkpointId, (err, logs) => {
            if (err) {
              console.log('Error getting logs from Auth0', err);
              return callback(err);
            }

            if (logs && logs.length) {
              logs.forEach((l) => context.logs.push(l));
              context.checkpointId = context.logs[context.logs.length - 1]._id;
            }

            console.log(`Total logs: ${context.logs.length}.`);
            return callback(null, context);
          });
        };

        getLogs({ checkpointId: startCheckpointId });
      },
      (context, callback) => {
        const min_log_level = parseInt(ctx.data.LOG_LEVEL) || 0;
        const log_matches_level = (log) => {
          if (logTypes[log.type]) {
            return logTypes[log.type].level >= min_log_level;
          }
          return true;
        }

        const types_filter = (ctx.data.LOG_TYPES && ctx.data.LOG_TYPES.split(',')) || [];
        const log_matches_types = (log) => {
          if (!types_filter || !types_filter.length) return true;
          return log.type && types_filter.indexOf(log.type) >= 0;
        };

        context.logs = context.logs
          .filter(l => l.type !== 'sapi' && l.type !== 'fapi')
          .filter(log_matches_level)
          .filter(log_matches_types);

        callback(null, context);
      },
      (context, callback) => {
        if (!context.logs.length) {
          return callback(null, context);
        }

        const url              = ctx.data.WEBHOOK_URL;
        const concurrent_calls = ctx.data.WEBHOOK_CONCURRENT_CALLS || 5;

        console.log(`Sending to '${url}' with ${concurrent_calls} concurrent calls.`);

        async.eachLimit(context.logs, concurrent_calls, (log, cb) => {
          request
            .post(url)
            .send(log)
            .set('Content-Type', 'application/json')
            .end((err, res) => {
              if (err) {
                console.log('Error sending request:', err);
                return cb(err);
              }

              if (!res.ok) {
                console.log('Unexpected response while sending request:', JSON.stringify(res.body));
                return cb(new Error('Unexpected response from webhook.'));
              }

              cb();
            });
        }, (err) => {
          if (err) {
            return callback(err);
          }

          console.log('Upload complete.');
          return callback(null, context);
        });
      }
    ], (err, context) => {
      if (err) {
        console.log('Job failed.');

        return req.webtaskContext.storage.set({checkpointId: startCheckpointId}, {force: 1}, (error) => {
          if (error) {
            console.log('Error storing startCheckpoint', error);
            return res.status(500).send({error: error});
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
      }, {force: 1}, (error) => {
        if (error) {
          console.log('Error storing checkpoint', error);
          return res.status(500).send({error: error});
        }

        res.sendStatus(200);
      });
    });
  });
}

const logTypes = {
  's': {
    event: 'Success Login',
    level: 1 // Info
  },
  'seacft': {
    event: 'Success Exchange',
    level: 1 // Info
  },
  'feacft': {
    event: 'Failed Exchange',
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
  'fapi': {
    event: 'Failed API Operation'
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
  }
};

function getPageOfLogsFromAuth0 (domain, token, take, from, cb) {
  var url = `https://${domain}/api/v2/logs`;

  Request
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json')
    .query({ take: take })
    .query({ from: from })
    .query({ sort: 'date:1' })
    .query({ per_page: take })
    .end(function (err, res) {
      if (err || !res.ok) {
        console.log('Error getting logs', err);
        cb(err);
      } else {
        console.log('x-ratelimit-limit: ', res.headers['x-ratelimit-limit']);
        console.log('x-ratelimit-remaining: ', res.headers['x-ratelimit-remaining']);
        console.log('x-ratelimit-reset: ', res.headers['x-ratelimit-reset']);
        cb(null, res.body);
      }
    });
}

function getLogsFromAuth0(domain, token, take, from, cb) {
  var accumulator = [];

  var test = function() {
    return take > 0;
  };

  var iterator = function(iteratorCb) {
    var pageTake = take > 100 ? 100 : take;
    getPageOfLogsFromAuth0(domain, token, pageTake, from, function(err, logs) {
      if (err) {
        iteratorCb(err)
      } else if (logs.length === 0) {
        take = 0;
        iteratorCb();
      } else {
        accumulator = accumulator.concat(logs);
        if (pageTake === logs.length) {
          take -= logs.length;
          from = logs[logs.length - 1]._id
        } else {
          take = 0
        }
        iteratorCb();
      }
    });
  };

  async.whilst(test, iterator, function(err) {
    if (err) {
      cb(err);
    } else {
      cb(null, accumulator);
    }
  });
}

const getTokenCached = memoizer({
  load: (apiUrl, audience, clientId, clientSecret, cb) => {
    Request
      .post(apiUrl)
      .send({
        audience: audience,
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
      .type('application/json')
      .end(function (err, res) {
        if (err || !res.ok) {
          cb(null, err);
        } else {
          cb(res.body.access_token);
        }
      });
  },
  hash: (apiUrl) => apiUrl,
  max: 100,
  maxAge: 1000 * 60 * 60
});

app.use(function (req, res, next) {
  var apiUrl       = `https://${req.webtaskContext.data.AUTH0_DOMAIN}/oauth/token`;
  var audience     = `https://${req.webtaskContext.data.AUTH0_DOMAIN}/api/v2/`;
  var clientId     = req.webtaskContext.data.AUTH0_CLIENT_ID;
  var clientSecret = req.webtaskContext.data.AUTH0_CLIENT_SECRET;

  getTokenCached(apiUrl, audience, clientId, clientSecret, function (access_token, err) {
    if (err) {
      console.log('Error getting access_token', err);
      return next(err);
    }

    req.access_token = access_token;
    next();
  });
});

app.get ('/', lastLogCheckpoint);
app.post('/', lastLogCheckpoint);

module.exports = Webtask.fromExpress(app);
