var nodegit = require('nodegit'),
       cred = nodegit.Cred;

// remote must use ssh:// protocol when returning a ssh key credential
module.exports = function(url, userName) {
  // return cred.sshKeyFromAgent(userName);
  return cred.sshKeyNew(userName, '/home/build/.ssh/github_id_rsa.pub', '/home/build/.ssh/github_id_rsa', '');
}
