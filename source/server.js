import bodyParser from 'body-parser';
import express from 'express';
import ExpressBrute from 'express-brute';
import expressJSDocSwagger from 'express-jsdoc-swagger';
import GithubWebHook from 'express-github-webhook';
import objectPath from 'object-path';

import auth from './controllers/auth';
import config from './config';
import connect from './controllers/connect';
import encrypt from './controllers/encrypt';
import handlePR from './controllers/handlePR';
import home from './controllers/home';
import process from './controllers/process';
import pkg from '../package.json';

export default class StaticmanAPI {
  constructor() {
    const swaggerOptions = {
      info: {
        title: pkg.name,
        description:
          'For use by static websites to allow submission dynamically generated content, such as comments.',
        version: pkg.version,
        license: {
          name: pkg.license,
        },
      },
      filesPattern: __filename,
      baseDir: __dirname,
    };

    this.controllers = {
      connect,
      encrypt,
      auth,
      handlePR,
      home,
      process,
    };

    this.server = express();
    this.server.use(bodyParser.json());
    this.server.use(
      bodyParser.urlencoded({
        extended: true,
        // type: '*'
      })
    );

    this.initialiseWebhookHandler();
    this.initialiseCORS();
    this.initialiseBruteforceProtection();
    this.initialiseRoutes();

    expressJSDocSwagger(this.server)(swaggerOptions);
  }

  initialiseBruteforceProtection() {
    const store = new ExpressBrute.MemoryStore();

    this.bruteforce = new ExpressBrute(store);
  }

  initialiseCORS() {
    this.server.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

      next();
    });
  }

  initialiseRoutes() {
    /**
     * GET /v{version}/connect/{username}/{repository}
     * @summary Used when running Staticman on a bot account to accept GitHub repo collaboration invites.
     * @tags Bot Connection
     * @param {number} version.path - Staticman API version - enum:1,2,3
     * @param {string} username.path - Github username
     * @param {string} repository.path - Github repository name
     * @return {string} 200 - Success - text/html
     * @example response - 200 - Example success response
     * Staticman connected!
     * @return {string} 404 - Invitation not found - text/html
     * @example response - 404 - Example invitation not found response
     * Invitation not found
     * @return {string} 500 - Staticman server error - text/html
     * @example response - 500 - Example Staticman server error response
     * Error
     */
    this.server.get(
      '/v:version/connect/:username/:repository',
      this.bruteforce.prevent,
      StaticmanAPI.requireApiVersion([1, 2, 3]),
      this.controllers.connect
    );

    /**
     * POST /v{version}/entry/{username}/{repository}/{branch}
     * @summary Used to submit a comment to a website connected to Staticman.
     * @deprecated
     * @tags Entry Submission
     * @param {number} version.path - Staticman API version - enum:1,2
     * @param {string} username.path - Github username
     * @param {string} repository.path - Github repository name
     * @param {string} branch.path - Repository branch
     * @return {string} 200 - Success
     * @return {string} 500 - Staticman server error
     */
    this.server.post(
      '/v:version/entry/:username/:repository/:branch',
      this.bruteforce.prevent,
      StaticmanAPI.requireApiVersion([1, 2]),
      StaticmanAPI.requireParams(['fields']),
      this.controllers.process
    );

    /**
     * POST /v{version}/entry/{username}/{repository}/{branch}/{property}
     * @summary Used to submit a comment to a website connected to Staticman.
     * @deprecated
     * @tags Entry Submission
     * @param {number} version.path - Staticman API version - enum:2
     * @param {string} username.path - Github username
     * @param {string} repository.path - Github repository name
     * @param {string} branch.path - Repository branch
     * @param {string} property.path - Name of the top level key in the Staticman config
     * @return {string} 200 - Success
     * @return {string} 500 - Staticman server error
     */
    this.server.post(
      '/v:version/entry/:username/:repository/:branch/:property',
      this.bruteforce.prevent,
      StaticmanAPI.requireApiVersion([2]),
      StaticmanAPI.requireParams(['fields']),
      this.controllers.process
    );

    /**
     * POST /v{version}/entry/{service}/{username}/{repository}/{branch}/{property}
     * @summary Used to submit a comment to a website connected to Staticman.
     * @tags Entry Submission
     * @param {number} version.path - Staticman API version - enum:3
     * @param {string} service.path - Git service - enum:github,gitlab
     * @param {string} username.path - Github username
     * @param {string} repository.path - Github repository name
     * @param {string} branch.path - Repository branch
     * @param {string} property.path - Name of the top level key in the Staticman config
     * @return {string} 200 - Success
     * @return {string} 500 - Staticman server error
     */
    this.server.post(
      '/v:version/entry/:service/:username/:repository/:branch/:property',
      this.bruteforce.prevent,
      StaticmanAPI.requireApiVersion([3]),
      StaticmanAPI.requireService(['github', 'gitlab', 'onedev']),
      StaticmanAPI.requireParams(['fields']),
      this.controllers.process
    );

    /**
     * GET /v{version}/encrypt/{text}
     * @summary Encrypt a string
     * @tags Security
     * @param {number} version.path - Staticman API version - enum:2,3
     * @param {string} text.path - Text to encrypt
     * @return {string} 200 - Success
     * @return {string} 500 - Could not encrypt text
     */
    this.server.get(
      '/v:version/encrypt/:text',
      this.bruteforce.prevent,
      StaticmanAPI.requireApiVersion([2, 3]),
      this.controllers.encrypt
    );

    /**
     * GET /v{version}/auth/{service}/{username}/{repository}/{branch}/{property}
     * @summary Authenticate with the git service using oauth
     * @tags Authentication
     * @param {number} version.path - Staticman API version - enum:3
     * @param {string} service.path - Git service - enum:github,gitlab
     * @param {string} username.path - Github username
     * @param {string} repository.path - Github repository name
     * @param {string} branch.path - Repository branch
     * @param {string} property.path - Name of the top level key in the Staticman config
     * @return {string} 200 - Success
     * @return {string} 401 - Authentication error
     */
    this.server.get(
      '/v:version/auth/:service/:username/:repository/:branch/:property',
      this.bruteforce.prevent,
      StaticmanAPI.requireApiVersion([2, 3]),
      StaticmanAPI.requireService(['github', 'gitlab', 'onedev']),
      this.controllers.auth
    );

    /**
     * GET /
     * @summary Staticman API home message
     * @tags Misc
     * @return {string} 200 - Success - text/html
     * @example response - 200 - Example success response
     * Hello from Staticman version 3.0.0!
     */
    this.server.get('/', this.controllers.home);
  }

  initialiseWebhookHandler() {
    const webhookHandler = GithubWebHook({
      path: '/v1/webhook',
    });

    webhookHandler.on('pull_request', this.controllers.handlePR);

    this.server.use(webhookHandler);
  }

  static requireApiVersion(versions) {
    return (req, res, next) => {
      const versionMatch = versions.some((version) => {
        return version.toString() === req.params.version;
      });

      if (!versionMatch) {
        return res.status(400).send({
          success: false,
          errorCode: 'INVALID_VERSION',
        });
      }

      return next();
    };
  }

  static requireService(services) {
    return (req, res, next) => {
      const serviceMatch = services.some((service) => service === req.params.service);

      if (!serviceMatch) {
        return res.status(400).send({
          success: false,
          errorCode: 'INVALID_SERVICE',
        });
      }

      return next();
    };
  }

  static requireParams(params) {
    return (req, res, next) => {
      const missingParams = [];

      params.forEach((param) => {
        if (
          objectPath.get(req.query, param) === undefined &&
          objectPath.get(req.body, param) === undefined
        ) {
          missingParams.push(param);
        }
      });

      if (missingParams.length) {
        return res.status(500).send({
          success: false,
          errorCode: 'MISSING_PARAMS',
          data: missingParams,
        });
      }

      return next();
    };
  }

  start(callback) {
    this.instance = this.server.listen(config.get('port'), () => {
      if (typeof callback === 'function') {
        callback(config.get('port'));
      }
    });
  }

  close() {
    this.instance.close();
  }
}
