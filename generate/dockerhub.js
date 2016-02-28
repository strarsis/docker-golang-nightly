var dockerHubApi  = require('docker-hub-api'), // (supports promises)
    moment        = require('moment'),
    Promise       = require('bluebird');


var dockerHubAuth = require('./config/docker-hub-auth');

var config        = require('./config/config');
var dockerHubInfo = {
  username:   config.downstream.dockerhub.user,
  repository: config.downstream.dockerhub.repo
};

// test
var buildTagName  = 'build-1.6-nightly-71cc445cf92dd3014e8b382809ed1b9c077e7973';


// from task.js
var nightlyVersionStr = function(version, sha) {
  return [ version, '-nightly-', sha ].join('');
};
var buildTagPrefix = 'build-';
var getBuildTagName = function(version) {
  return buildTagPrefix + version;
};


var BUILD_STATUS_SUCCEEDED = 10;
var BUILD_STATUS_FAILED    = -1;
var bySuccessfulBuild = function(build) {
  return (build.status == BUILD_STATUS_SUCCEEDED);
};


var getCommitShaFromDockerfile = function(dockerfile) {
  return dockerfile.match(/ENV GOLANG_BUILD_SHA[ ]+(.*)/)[1];
};

var getVersionFromDockerfile = function(dockerfile) {
  return dockerfile.match(/ENV GOLANG_BASE_VERSION[ ]+(.*)/)[1];
};


var byCreatedDateAsc = function(tagA, tagB) {
  return dockerhubCompareDates(
    tagA.created_date,
    tagB.created_date
  );
};
var dockerhubCompareDates = function(dateStrA, dateStrB) {
  return moment(dateStrA).diff(dateStrB);
};


dockerHubApi.login(dockerHubAuth.username, dockerHubAuth.password)
.then(function(loginInfo) {
  return dockerHubApi.buildHistory(dockerHubInfo.username, dockerHubInfo.repository);
})
.then(function(builds) {

  var buildsSorted           = builds.sort(byCreatedDateAsc);
  var successfulBuildsSorted = buildsSorted.filter(bySuccessfulBuild);


  // - the last tagged build
  var successfulPastTagBuilds = successfulBuildsSorted.filter(function(build) {
    return (build.dockertag_name == buildTagName);
  });


  // - the last 'latest' build
  var successfulPastLatestBuilds = successfulBuildsSorted.filter(function(build) {
    return (build.dockertag_name == 'latest');
  });

  // determine the build tag of the last 'latest' build
  var successfulPastLastLatestBuild = successfulPastLatestBuilds[ successfulPastLatestBuilds.length-1 ];
  return dockerHubApi.buildDetails(dockerHubInfo.username, dockerHubInfo.repository, successfulPastLastLatestBuild.build_code)
  .then(function(buildDetails) {
    var dockerfileLastLatestBuild = buildDetails.build_results.dockerfile_contents;
    var versionLastLatestBuild    = getVersionFromDockerfile(dockerfileLastLatestBuild);
    var shaLastLatestBuild        = getCommitShaFromDockerfile(dockerfileLastLatestBuild);

    var nightlyVersionLastLatestBuild = nightlyVersionStr(versionLastLatestBuild, shaLastLatestBuild);
    var buildTagNameLastLatestBuild   = getBuildTagName(nightlyVersionLastLatestBuild);


    // - now build tags last tag + latest builds have both been determined
    var triggerJobs = [];

    if(successfulPastTagBuilds.length == 0) {
      // trigger with build tag for tagged build
      triggerJobs.push(
        dockerHubApi.triggerBuild(dockerHubInfo.username, dockerHubInfo.repository, {
          source_name: buildTagName,
          source_type: 'tag'
        })
        .then(function() {
          console.log("Triggered tagged build with tag '" + buildTagName + "'.");
        })
      );
    } else {
      console.log('Last tagged build was already built, skipped.');
    }

    // Note: building 'latest' only makes sense with the most recent build tag name,
    //       - it wouldn't make sense building 'latest' for past build tag names.
    if(buildTagNameLastLatestBuild != buildTagName) {
      // trigger with master branch for 'latest' build
      triggerJobs.push(
        dockerHubApi.triggerBuild(dockerHubInfo.username, dockerHubInfo.repository, {
          source_name: 'master',
          source_type: 'branch'
        })
        .then(function() {
          console.log("Triggered 'latest' build with master branch.");
        })
      );
    } else {
      console.log("Last 'latest' build was already built, skipped.");
    }

    return Promise.join(triggerJobs);
  });

})
.then(function() {
  console.log('Done.');
})
.catch(function(err) {
  console.log(err);
});
