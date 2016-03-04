var Promise          = require('bluebird'),
    GitHubApi        = require('github'),
    objectAssign     = require('object-assign'),
    GithubApiTags    = require('github-api-tags-full'),
    moment           = require('moment'),
    Nodegit          = require('nodegit'),
    ejs              = require('ejs'),
    fs               = Promise.promisifyAll(require('fs')),
    path             = require('path'),
    optional         = require('optional'),
    ProgressBar      = require('progress'),
    helper           = require('./helper'),
    dockerHubBuilder = require('./docker-hub-builder');

//var replay = require('replay');

var repoFolder = path.join(__dirname, '../.');

var config        = require(path.join(__dirname, './config/config.json'));

// Upstream Github repo
var repoId        = config.upstream.github;

// Git(hub) info for repository / committing/authoring
var gitInfo       = config.downstream.github.user;
// Auth against Github account for pushing to repository
var githubRepoAuthCb = require(path.join(__dirname, './config/github-repo-auth'));

// Dockerhub repository info
var dockerHubInfo = { // same named 'user' + 'repo' field in config for all services
  username:   config.downstream.dockerhub.user,
  repository: config.downstream.dockerhub.repo
};
// Auth against Dockerhub account for managing/triggering builds
var dockerHubAuth = require(path.join(__dirname, './config/docker-hub-auth.json'));


var github = new GitHubApi({
  version: '3.0.0'
});

// (Optional) Auth against Github API for higher API rate limits
var githubApiAuth = optional(path.join(__dirname, './config/github-api-auth'));
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


  var gat = new GithubApiTags();

  var bar = new ProgressBar('Fetching full tag :current/:total [:bar] :percent :etas', { total: 100 });
  var pageFetched = function() {
    bar.total = this.tagsAll;
  };
  var tagFetched = function() {
    bar.tick();
  };
  gat.on('page', pageFetched);
  gat.on('tag',  tagFetched);

  return gat.fetch(repoId, github)
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

Promise.join(
  getLastCommitSha(repoId, github),
  getLastTagVersion(repoId, github),
  openGitRepoAndGetGitTags(repoFolder),

function(sha, version, gitRepoAndGitTags) {
  var data    = { sha: sha, version: version };
  var gitRepo = gitRepoAndGitTags[0];
  var tags    = gitRepoAndGitTags[1];

  var nightlyVersion = helper.nightlyVersionStr(data.version, data.sha);
  console.log('Nightly version: ' + nightlyVersion);

  var buildTagName = helper.getBuildTagName(nightlyVersion);

  if(tags.indexOf(buildTagName) > -1) {
    console.log('Latest nightly version build tag already exists (' + buildTagName + '). Skipped.');
  } else {
    console.log('Generating Dockerfile...');
    return renderFile(path.join(repoFolder, 'generate', 'Dockerfile.ejs'), data)
    .then(function(DockerfileStr) {
      console.log('Writing Dockerfile...');
      return fs.writeFileAsync(path.join(repoFolder, 'Dockerfile'),  DockerfileStr);
    })
    .then(function() {
      console.log('Committing + tagging new Dockerfile...');
      return gitAddCommit(gitRepo, 'Dockerfile', gitInfo, 'Update Dockerfile for nightly build ' + nightlyVersion, buildTagName)
      .then(function() {

        return gitPushAll(gitRepo)
        .then(function() {
          console.log('Ensuring Dockerhub builds.');
          return dockerHubBuilder.handleRepository(dockerHubAuth, dockerHubInfo, buildTagName);
        });
      });
    });
  }

  return gitPushAll(gitRepo)
  .then(function() {
    console.log('Ensuring Dockerhub builds.');
    return dockerHubBuilder.handleRepository(dockerHubAuth, dockerHubInfo, buildTagName);
  });
})
.then(function() {
  console.log('Done.');
})
.catch(function(err) {
  console.log('Error: ' + err);
});

var regexpBuildTag = new RegExp('^' + helper.buildTagPrefix);
var onlyBuildTag   = function(tag) {
  return regexpBuildTag.test(tag);
};

var refSpecMaster = 'refs/heads/master:refs/heads/master';
var gitPushAll = function(gitRepo) {
  console.log('Pushing to remote origin repository...');
  return getGitTags(gitRepo) // load tags anew (if new have been added)
  .then(function(gitTags) {
    var gitTagsBuild = gitTags.filter(onlyBuildTag);
    return gitRepo.getRemote('origin')
    .then(function(gitRemote) {
      return gitPushRefSpecs(
        gitRemote,
        tagsToRefSpecs(gitTagsBuild).concat(refSpecMaster),
        githubRepoAuthCb
      );
    });
  });
};

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

    author    = Nodegit.Signature.now(gitInfo.author.name,    gitInfo.author.email);
    committer = Nodegit.Signature.now(gitInfo.committer.name, gitInfo.committer.email);

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

var tagsToRefSpecs = function(tags) {
  var refSpecs     = [];
  for(tagIndex in tags) {
    var tag = tags[ tagIndex ];
    var refSpecStr = 'refs/tags/' + tag + ':' + 'refs/tags/' + tag;
    refSpecs.push(refSpecStr);
  }
  return refSpecs;
};

var gitPushRefSpecs = function(remote, refSpecs, githubRepoAuthCb) {
  return remote.push(
    refSpecs,
    {
      options: 'tags',
      callbacks: {
        credentials: githubRepoAuthCb
      }
    }
  );
};
