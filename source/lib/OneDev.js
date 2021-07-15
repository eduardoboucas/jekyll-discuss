import config from '../config';
import GitService from './GitService';
import Review from './models/Review';
import User from './models/User';

import got from 'got';

export default class OneDev extends GitService {
  constructor(options = {}) {
    super(options.username, options.repository, options.branch);

    this.api = got.extend({
      prefixUrl: config.get('onedevBaseUrl'),
      username: config.get('onedevUsername'),
      password: config.get('onedevPassword'),
      responseType: 'json'
    });
  }

  _pullFile(path, branch) {
    return this.api.get(`repositories/${this.repository}/files/${branch}/${path}`)
      .then((res) => ({content: res.body.base64Content}));
  }

  _commitFile(path, content, commitMessage, branch) {
    return this.api.post(
      `repositories/${this.repository}/files/${branch}/${path}`, {
        json: {
          '@type': 'FileCreateOrUpdateRequest',
          commitMessage: commitMessage,
          base64Content: content
        }
      }
    );
  }

  getBranchHeadCommit(branch) {
    return this.api.get(`repositories/${this.repository}/branches/${branch}`)
      .then((res) => res.body.commitHash);
  }

  createBranch(branch, sha) {
    return this.api.post(
      `repositories/${this.repository}/branches`, {
        json: {
          branchName: branch,
          revision: sha
        }
      }
    );
  }

  deleteBranch(branch) {
    return this.api.delete(`repositories/${this.repository}/branches/${branch}`);
  }

  createReview(reviewTitle, branch, reviewBody) {
    return this.api.post(
      `pull-requests`, {
        json: {
          targetProjectId: this.repository,
          sourceProjectId: this.repository,
          targetBranch: this.branch,
          sourceBranch: branch,
          title: reviewTitle,
          description: reviewBody
        }
      }
    );
  }

  getReview(reviewId) {
    return this.api.get(`pull-requests/${reviewId}`)
      .then(res => new Review(res.body.title, res.body.description, '', res.body.sourceBranch, res.body.targetBranch));
  }

  getCurrentUser() {
    return this.api.get(`users/me`)
      .then(res => new User('onedev', res.body.name || '', res.body.email || '', res.body.fullName || '', '', '', '', ''));
  }
}
