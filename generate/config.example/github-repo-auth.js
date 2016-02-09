var nodegit = require('nodegit'),
       cred = nodegit.Cred;

module.exports = function(url, userName) {
  // return cred.sshKeyFromAgent(userName);
  return cred.sshKeyNew(userName, '/home/build/github_id_rsa.pub', '/home/build/github_id_rsa', '');
}
