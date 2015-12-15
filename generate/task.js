var Promise       = require('bluebird'),
    GitHubApi     = require('github'),
    objectAssign  = require('object-assign'),
    GithubApiTags = require('github-api-tags-full'),
    moment        = require('moment'),
    Nodegit       = require('nodegit'),
    ejs           = require('ejs'),
    fs            = Promise.promisifyAll(require('fs')),
    path          = require('path'),
    optional      = require('optional');


var repoFolder = path.join(__dirname, '../.');

var config  = require('./config/config.json');
var repoId  = config.upstream.github;
var gitInfo = config.downstream.user;

// Auth against Github repository for pushing
var githubRepoAuthCb = require('./config/github-repo-auth');


var github = new GitHubApi({
  version: '3.0.0'
});

// Auth against Github API for higher API rate limits
var githubApiAuth = optional('./config/github-api-auth');
if(githubApiAuth) {
  github.authenticate(githubApiAuth);
}


Promise.promisifyAll(github.repos);

var getLastCommitSha = function(repoId, github) {
  console.log('Getting last commit sha...');
  return github.repos.getCommitsAsync(
    objectAssign(repoId, { per_page: 1 }) // only 1st/last commit
  )
  .then(function(commits) {
    var lastCommit = commits[0];
    var sha        = lastCommit.sha;
    console.log('Got last commit sha: ' + sha);
    return sha;
  });
};


var getLastTagVersion = function(repoId, github) {
  console.log('Getting last tag version...');

  return GithubApiTags(repoId, github)
  .then(function(tags) {
    var tagsSortedDateDesc = tags.sort(byAuthorDateAsc).reverse();
    var lastRelease        = tagsSortedDateDesc[0];
    var lastVersion        = cleanReleaseName(lastRelease.name, repoId.repo);

    console.log('Got last tag version: ' + lastVersion);
    return lastVersion;
  });
};

var byAuthorDateAsc = function(tagA, tagB) {
  return githubCompareDates(
    tagA.commit.author.date,
    tagB.commit.author.date
  );
};
var githubCompareDates = function(dateStrA, dateStrB) {
  return moment(dateStrA).diff(dateStrB);
};

var cleanReleaseName = function(releaseName, repoId) {
  var clRx = new RegExp('^' + repoId);
  return releaseName.replace(clRx, '');
};

var nightlyVersionStr = function(version, sha) {
  return [ version, '-nightly-', sha ].join('');
};


var getGitTags = function(gitRepo) {
  return Nodegit.Tag.list(gitRepo);
};

var openGitRepo = function(repoFolder) {
  return Nodegit.Repository.open(repoFolder);
};

var openGitRepoAndGetGitTags = function(repoFolder) {
  var gitRepo, tags;
  return openGitRepo(repoFolder)
  .then(function(gitRepoResult) {
    gitRepo = gitRepoResult;
    return getGitTags(gitRepo);
  })
  .then(function(tags) {
    return [ gitRepo, tags ];
  });
};

Promise.all([
  getLastCommitSha(repoId, github),
  getLastTagVersion(repoId, github),
  openGitRepoAndGetGitTags(repoFolder)
])
.then(function(args) {
  var data    = { sha: args[0], version: args[1] };
  var gitRepo = args[2][0];
  var tags    = args[2][1];

  var nightlyVersion = nightlyVersionStr(data.version, data.sha);
  console.log('Nightly version: ' + nightlyVersion);

  var buildTagName = 'build-' + nightlyVersion;

  if(tags.indexOf(buildTagName) > -1) {
    console.log('Latest nightly version build tag already exists (' + buildTagName + '). Skipped.');
    return false;
  }

  console.log('Generating Dockerfile...');
  return renderFile(path.join(repoFolder, '..', 'Dockerfile.ejs'), data)
  .then(function(DockerfileStr) {
    console.log('Writing Dockerfile...');
    return fs.writeFileAsync(path.join(repoFolder, 'Dockerfile'),  DockerfileStr);
  })
  .then(function() {
     console.log('Committing + tagging new Dockerfile...');
     return gitAddCommit(gitRepo, 'Dockerfile', gitInfo, 'Update Dockerfile for nightly build ' + nightlyVersion, buildTagName)
      .then(function() {
        console.log('Pushing to remote origin repository...');
        return gitPushMaster(gitRepo, 'test', githubRepoAuthCb);
      });
  });
})
.then(function() {
  console.log('Done.');
})
.catch(function(err) {
  console.log('Error: ' + err);
});


var renderFile = function(templatePath, data) {
  return fs.readFileAsync(templatePath, { encoding: 'utf8' })
  .then(function(DockerfileTemplateStr) {
    var DockerfileRendered = ejs.render(
      DockerfileTemplateStr,
      data
    );
    return DockerfileRendered;
  });
};

var gitAddCommit = function(repo, fileToStage, gitInfo, commitMsg, tagName) {
  var index, oid;

  return repo.openIndex()
  .then(function(indexResult) {
    index  = indexResult;

    // this file is in the root of the directory and doesn't need a full path
    index.addByPath(fileToStage);

    // this will write files to the index
    index.write();

    return index.writeTree();

  }).then(function(oidResult) {

    oid = oidResult;
    return Nodegit.Reference.nameToId(repo, 'HEAD');

  }).then(function(head) {

    return repo.getCommit(head);

  }).then(function(parent) {

    author    = Nodegit.Signature.now(gitInfo.author.name,   gitInfo.author.email);
    committer = Nodegit.Signature.now(gitInfo.commiter.name, gitInfo.commiter.email);

    return repo.createCommit('HEAD', author, committer, commitMsg, oid, [parent]);
  }).then(function(commitId) {
    console.log('New Commit: ', commitId);
    return Nodegit.Object.lookup(repo, commitId, Nodegit.Object.string2type('commit'));
  }).then(function(commitObj) {
    return Nodegit.Tag.createLightweight(repo, tagName, commitObj, 0);
  }).then(function(tagId) {
    console.log('New lightweight tag for commit: ', tagId);
    return;
  });
};

var gitPushMaster = function(repo, remoteName, githubRepoAuthCb) {
  return repo.getRemote(remoteName)
  .then(function(remoteResult) {

    console.log('Remote loaded.');
    remote = remoteResult;

    return remote.push(
             ['refs/heads/master:refs/heads/master'],
             {
               options: 'tags',
               callbacks: {
                 credentials: githubRepoAuthCb
               }
             }
           );
  }).then(function() {
    console.log('Remote pushed.')
  });
};
