import gitFactory from '../lib/GitServiceFactory';
import * as oauth from '../lib/OAuth';
import * as RSA from '../lib/RSA';
import Staticman from '../lib/Staticman';

export default async (req, res) => {
  const staticman = await new Staticman(req.params);
  staticman.setConfigPath();

  let requestAccessToken;

  switch (req.params.service) {
    case 'gitlab':
      requestAccessToken = (siteConfig) =>
        oauth.requestGitLabAccessToken(
          req.query.code,
          siteConfig.get('gitlabAuth.clientId'),
          siteConfig.get('gitlabAuth.clientSecret'),
          siteConfig.get('gitlabAuth.redirectUri')
        );
      break;
    case 'onedev':
      requestAccessToken = (siteConfig) => null;
      break;
    default:
      requestAccessToken = (siteConfig) =>
        oauth.requestGitHubAccessToken(
          req.query.code,
          siteConfig.get('githubAuth.clientId'),
          siteConfig.get('githubAuth.clientSecret'),
          siteConfig.get('githubAuth.redirectUri')
        );
  }

  return staticman
    .getSiteConfig()
    .then(requestAccessToken)
    .then(async (accessToken) => {
      const git = await gitFactory(req.params.service, {
        oauthToken: accessToken,
        version: req.params.version,
      });

      // TODO: Simplify this when v2 support is dropped.
      const getUser =
        req.params.version === '2' && req.params.service === 'github'
          ? git.api.users.getAuthenticated({}).then(({ data }) => data)
          : git.getCurrentUser();

      return getUser.then((user) => {
        res.send({
          accessToken: RSA.encrypt(accessToken),
          user,
        });
      });
    })
    .catch((err) => {
      console.log('ERR:', err);

      const statusCode = err.statusCode || 401;

      res.status(statusCode).send({
        statusCode,
        message: err.message,
      });
    });
};
