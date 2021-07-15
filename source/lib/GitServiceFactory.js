import GitLab from './GitLab';
import GitHub from './GitHub';
import OneDev from './OneDev';

export default async (service, options) => {
  switch (service) {
    case 'gitlab':
      return new GitLab(options);
    case 'onedev':
      return new OneDev(options);
    default:
      return new GitHub(options);
  }
};
