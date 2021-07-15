/* eslint-disable max-classes-per-file, no-shadow */

import OneDev from '../../../source/lib/OneDev';
import * as mockHelpers from '../../helpers';
import User from '../../../source/lib/models/User';

let req;

const btoa = (contents) => Buffer.from(contents).toString('base64');

beforeEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();

  req = mockHelpers.getMockRequest();
});

describe('OneDev interface', () => {
  test('initialises the OneDev API wrapper', () => {
    const onedev = new OneDev(req.params);

    expect(onedev.api).toBeDefined();
  });

  describe('readFile', () => {
    test('reads a file and returns its contents', () => {
      const fileContents = 'This is a text file!';
      const filePath = 'path/to/file.txt';
      const mockGet = jest.fn(() =>
        Promise.resolve({
          body: {
            base64Content: btoa(fileContents),
          },
        })
      );

      jest.mock('got', () => {
        return {
          extend: function mockGot() {
            return {
              get: mockGet,
            };
          },
        };
      });

      const OneDev = require('../../../source/lib/OneDev').default;
      const sut = new OneDev(req.params);

      return sut.readFile(filePath).then((contents) => {
        expect(mockGet.mock.calls[0][0]).toBe(
          `repositories/${req.params.repository}/files/${req.params.branch}/${filePath}`
        );
      });
    });
  });

  describe('writeFile', () => {
    test('creates a file on the given branch using the commit title provided', () => {
      const options = {
        branch: 'master',
        commitTitle: 'Adds a new file',
        content: 'This is a new file',
        path: 'path/to/file.txt',
      };
      const mockPost = jest.fn(() =>
        Promise.resolve(null)
      );

      jest.mock('got', () => {
        return {
          extend: function mockGot() {
            return {
              post: mockPost,
            };
          },
        };
      });

      const OneDev = require('../../../source/lib/OneDev').default;
      const sut = new OneDev(req.params);

      return sut
        .writeFile(options.path, options.content, options.branch, options.commitTitle)
        .then((response) => {
          expect(mockPost).toHaveBeenCalledTimes(1);
          expect(mockPost.mock.calls[0][0]).toBe(
            `repositories/${req.params.repository}/files/${options.branch}/${options.path}`
          );
          expect(mockPost.mock.calls[0][1]).toEqual({
            json: {
              '@type': 'FileCreateOrUpdateRequest',
              commitMessage: options.commitTitle,
              base64Content: btoa(options.content)
            }
          });
        });
    });
  });

  describe('writeFileAndSendReview', () => {
    test('writes a file to a new branch and sends a PR to the base branch provided, using the given title and body for the commit/PR', () => {
      const options = {
        commitBody: 'This is a very cool file indeed...',
        commitTitle: 'Adds a new file',
        content: 'This is a new file',
        name: 'file.txt',
        newBranch: 'staticman_123456789',
        path: 'path/to/file.txt',
        sha: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
      };

      const mockPost = jest.fn(() =>
        Promise.resolve(null)
      );
      const mockGet = jest.fn(() =>
        Promise.resolve({
          body: {
            commitHash: options.sha,
          }
        })
      );

      jest.mock('got', () => {
        return {
          extend: function mockGot() {
            return {
              post: mockPost,
              get: mockGet,
            };
          },
        };
      });

      const OneDev = require('../../../source/lib/OneDev').default;
      const sut = new OneDev(req.params);

      return sut
        .writeFileAndSendReview(
          options.path,
          options.content,
          options.newBranch,
          options.commitTitle,
          options.commitBody
        )
        .then((response) => {
          expect(mockGet).toHaveBeenCalledTimes(1);
          expect(mockGet.mock.calls[0][0]).toBe(
            `repositories/${req.params.repository}/branches/${req.params.branch}`
          );

          expect(mockPost).toHaveBeenCalledTimes(3);
          expect(mockPost.mock.calls[0][0]).toBe(
            `repositories/${req.params.repository}/branches`
          );
          expect(mockPost.mock.calls[0][1]).toEqual({
            json: {
              branchName: options.newBranch,
              revision: options.sha
            }
          });

          expect(mockPost.mock.calls[1][0]).toBe(
            `repositories/${req.params.repository}/files/${options.newBranch}/${options.path}`
          );
          expect(mockPost.mock.calls[1][1]).toEqual({
            json: {
              '@type': 'FileCreateOrUpdateRequest',
              commitMessage: options.commitTitle,
              base64Content: btoa(options.content)
            }
          });

          expect(mockPost.mock.calls[2][0]).toBe(
            `pull-requests`
          );
          expect(mockPost.mock.calls[2][1]).toEqual({
            json: {
              targetProjectId: req.params.repository,
              sourceProjectId: req.params.repository,
              targetBranch: req.params.branch,
              sourceBranch: options.newBranch,
              title: options.commitTitle,
              description: options.commitBody
            }
          });
        });
    });
  });

  describe('getCurrentUser', () => {
    test('returns the current authenticated user', () => {
      const mockGet = jest.fn(() =>
        Promise.resolve({
          body: {
            name: 'johndoe',
            email: 'johndoe@test.com',
            fullName: 'John Doe',
          }
        })
      );

      jest.mock('got', () => {
        return {
          extend: function mockGot() {
            return {
              get: mockGet,
            };
          },
        };
      });

      const OneDev = require('../../../source/lib/OneDev').default;
      const sut = new OneDev(req.params);

      return sut.getCurrentUser().then((user) => {
        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(mockGet.mock.calls[0][0]).toBe(
          `users/me`
        );
        expect(user).toEqual(new User('onedev', 'johndoe', 'johndoe@test.com', 'John Doe'));
      });
    });
  });
});
