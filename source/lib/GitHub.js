import { createAppAuth } from '@octokit/auth-app';
import GithubApi from '@octokit/rest';
import { request } from '@octokit/request';

import config from '../config';
import errorHandler from './ErrorHandler';
import GitService from './GitService';
import Review from './models/Review';
import User from './models/User';

const normalizeResponse = ({ data }) => data;

export default class GitHub extends GitService {
  constructor(options = {}) {
    super(options.username, options.repository, options.branch);

    return (async () => {
      const isAppAuth = config.get('githubAppID') && config.get('githubPrivateKey');
      const isLegacyAuth = config.get('githubToken');

      let authToken;

      if (options.oauthToken) {
        authToken = options.oauthToken;
      } else if (isAppAuth) {
        authToken = await GitHub._authenticate(options.username, options.repository);
      } else if (isLegacyAuth) {
        authToken = config.get('githubToken');
      } else {
        throw new Error('Require an `oauthToken` or `token` option');
      }

      this.api = GithubApi({
        auth: `token ${authToken}`,
        userAgent: 'Staticman',
        baseUrl: config.get('githubBaseUrl'),
        request: {
          timeout: 5000,
        },
      });

      return this;
    })();
  }

  static async _authenticate(username, repository) {
    const auth = createAppAuth({
      appId: config.get('githubAppID'),
      privateKey: config.get('githubPrivateKey'),
    });

    const appAuth = await auth({ type: "app" });

    const { data } = await request('GET /repos/{owner}/{repo}/installation', {
      headers: {
        authorization: `Bearer ${appAuth.token}`,
      },
      owner: username,
      repo: repository,
    });

    const installationId = data.id;

    const token = await auth({ type: "installation", installationId });

    return token;
  }

  _pullFile(filePath, branch) {
    return this.api.repos
      .getContents({
        owner: this.username,
        repo: this.repository,
        path: filePath,
        ref: branch,
      })
      .then(normalizeResponse)
      .catch((err) => Promise.reject(errorHandler('GITHUB_READING_FILE', { err })));
  }

  _commitFile(filePath, content, commitMessage, branch) {
    return this.api.repos
      .createOrUpdateFile({
        owner: this.username,
        repo: this.repository,
        path: filePath,
        message: commitMessage,
        content,
        branch,
      })
      .then(normalizeResponse);
  }

  writeFile(filePath, data, targetBranch, commitTitle) {
    return super.writeFile(filePath, data, targetBranch, commitTitle).catch((err) => {
      try {
        const message = err?.message;

        if (message) {
          const parsedError = JSON.parse(message);

          if (parsedError?.message.includes('"sha" wasn\'t supplied')) {
            return Promise.reject(errorHandler('GITHUB_FILE_ALREADY_EXISTS', { err }));
          }
        }
      } catch (errorParsingError) {
        console.log(errorParsingError);
      }

      return Promise.reject(errorHandler('GITHUB_WRITING_FILE'));
    });
  }

  getBranchHeadCommit(branch) {
    return this.api.repos
      .getBranch({
        owner: this.username,
        repo: this.repository,
        branch,
      })
      .then((res) => res.data.commit.sha);
  }

  createBranch(branch, sha) {
    return this.api.git
      .createRef({
        owner: this.username,
        repo: this.repository,
        ref: `refs/heads/${branch}`,
        sha,
      })
      .then(normalizeResponse);
  }

  deleteBranch(branch) {
    return this.api.git.deleteRef({
      owner: this.username,
      repo: this.repository,
      ref: `heads/${branch}`,
    });
  }

  createReview(reviewTitle, branch, reviewBody) {
    return this.api.pullRequests
      .create({
        owner: this.username,
        repo: this.repository,
        title: reviewTitle,
        head: branch,
        base: this.branch,
        body: reviewBody,
      })
      .then(normalizeResponse);
  }

  getReview(reviewId) {
    return this.api.pulls
      .get({
        owner: this.username,
        repo: this.repository,
        pull_number: reviewId,
      })
      .then(normalizeResponse)
      .then(
        ({ base, body, head, merged, state, title }) =>
          new Review(
            title,
            body,
            merged && state === 'closed' ? 'merged' : state,
            head.ref,
            base.ref
          )
      );
  }

  async readFile(filePath, getFullResponse) {
    try {
      return await super.readFile(filePath, getFullResponse);
    } catch (err) {
      throw errorHandler('GITHUB_READING_FILE', { err });
    }
  }

  writeFileAndSendReview(filePath, data, branch, commitTitle, reviewBody) {
    return super
      .writeFileAndSendReview(filePath, data, branch, commitTitle, reviewBody)
      .catch((err) => Promise.reject(errorHandler('GITHUB_CREATING_PR', { err })));
  }

  getCurrentUser() {
    return this.api.users
      .getAuthenticated({})
      .then(normalizeResponse)
      .then(
        ({ login, email, avatar_url: avatarUrl, name, bio, company, blog }) =>
          new User('github', login, email, name, avatarUrl, bio, blog, company)
      )
      .catch((err) => Promise.reject(errorHandler('GITHUB_GET_USER', { err })));
  }
}
