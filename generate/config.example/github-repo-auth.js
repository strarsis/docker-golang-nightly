var nodegit = require('nodegit'),
       cred = nodegit.Cred;

module.exports = function(url, userName) {
  // return cred.sshKeyFromAgent(userName);
  return cred.sshKeyNew(userName, '/home/build/.ssh/github_id_rsa.pub', '/home/build/.ssh/github_id_rsa', '');
}
