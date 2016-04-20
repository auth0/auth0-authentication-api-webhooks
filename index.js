const Auth0   = require('auth0');
const request = require('superagent');
const async   = require('async');
const express = require('express');
const Webtask = require('webtask-tools');
const app     = express();

function lastLogCheckpoint(req, res) {
  let ctx               = req.webtaskContext;
  let required_settings = ['AUTH0_DOMAIN', 'AUTH0_GLOBAL_CLIENT_ID', 'AUTH0_GLOBAL_CLIENT_SECRET', 'WEBHOOK_URL'];
  let missing_settings  = required_settings.filter((setting) => !ctx.data[setting]);

  if (missing_settings.length) {
    return res.status(400).send({ message: 'Missing settings: ' + missing_settings.join(', ') });
  }

  // If this is a scheduled task, we'll get the last log checkpoint from the previous run and continue from there.
  req.webtaskContext.storage.get((err, data) => {
    if (err && err.output.statusCode !== 404) return res.status(err.code).send(err);

    let startCheckpointId = typeof data === 'undefined' ? null : data.checkpointId;

    // Initialize the Auth0 client.
    const auth0 = new Auth0({
      domain:       ctx.data.AUTH0_DOMAIN,
      clientID:     ctx.data.AUTH0_GLOBAL_CLIENT_ID,
      clientSecret: ctx.data.AUTH0_GLOBAL_CLIENT_SECRET
    });

    // Start the process.
    async.waterfall([
      //// STEP 1: Getting access token
      (callback) => {
        console.log('STEP 1: Getting access token');

        auth0.getAccessToken((err) => {
          if (err) {
            console.log('Error authenticating:', err);
          }
          return callback(err);
        });
      },
      //// STEP 2: Downloading logs
      (callback) => {
        console.log('STEP 2: Downloading logs');

        const getLogs = (context) => {
          console.log(`Downloading logs from: ${context.checkpointId || 'Start'}.`);

          context.logs = context.logs || [];

          auth0.getLogs({ take: 200, from: context.checkpointId }, (err, logs) => {
            if (err) {
              return callback(err);
            }

            if (logs && logs.length) {
              logs.forEach((l) => context.logs.push(l));
              context.checkpointId = context.logs[context.logs.length - 1]._id;
              return setImmediate(() => getLogs(context));
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

        console.log(`Filtered logs on log level '${min_log_level}': ${context.logs.length}.`);

        if (ctx.data.LOG_TYPES) {
          console.log(`Filtered logs on '${ctx.data.LOG_TYPES}': ${context.logs.length}.`);
        }

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
          if (error) return res.status(500).send(error);

          res.status(500).send({
            error: err
          });
        });
      }

      console.log('Job complete.');

      return req.webtaskContext.storage.set({checkpointId: context.checkpointId, totalLogsProcessed: context.logs.length}, {force: 1}, (error) => {
        if (error) return res.status(500).send(error);

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

app.get ('/', lastLogCheckpoint);
app.post('/', lastLogCheckpoint);


module.exports = Webtask.fromExpress(app);
