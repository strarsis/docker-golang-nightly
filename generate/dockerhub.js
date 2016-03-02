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
var buildTagName  = 'build-1.6-nightly-5fea2ccc77eb50a9704fa04b7c61755fe34e1d95';


// from task.js
var nightlyVersionStr = function(version, sha) {
  return [ version, '-nightly-', sha ].join('');
};
var buildTagPrefix = 'build-';
var getBuildTagName = function(version) {
  return buildTagPrefix + version;
};


const BUILD_STATUS_SUCCEEDED       = 10;
const BUILD_STATUS_FAILED          = -1;
const BUILD_STATUS_QUEUED          =  0;
const BUILD_STATUS_BUILDING        =  3;

const BUILD_TAG_SOURCE_TYPE_TAG    = 'Tag';
const BUILD_TAG_SOURCE_TYPE_BRANCH = 'Branch';


var isPendingBuild = function(build) {
  return (build.status == BUILD_STATUS_QUEUED || build.status == BUILD_STATUS_BUILDING);
};

// passing build = either successful or pending, not failed
var isPassingBuild = function(build) {
  return (isPendingBuild(build) || build.status == BUILD_STATUS_SUCCEEDED);
};


var findBuildTagsByDetails = function(buildTags, details) {
  return buildTags.filter(function(buildTag) {
    return compareBuildTagDetails(buildTag, details);
  });
};
var normalizeBuildDetails = function(details) {
  var detailsNormalized = details;

   detailsNormalized.name = details.name || '{sourceref}';
   if(details.source_name == 'master' && details.source_type == BUILD_TAG_SOURCE_TYPE_BRANCH) {
     detailsNormalized.name = 'latest';
   }

   detailsNormalized.dockerfile_location = details.dockerfile_location || '/';

   return detailsNormalized;
};
var compareBuildTagDetails = function(buildTag, details) {
  var detailsNormalized    = normalizeBuildDetails(details);
  return (
    buildTag.name                == detailsNormalized.name                && 
    buildTag.dockerfile_location == detailsNormalized.dockerfile_location && 
    buildTag.source_name         == detailsNormalized.source_name         && 
    buildTag.source_type         == detailsNormalized.source_type
  );
};

var reuseTagBuild       = function(dockerHubApi, username, repository, details) {
  var existingBuildTags = {};

  return dockerHubApi.buildSettings(dockerHubInfo.username, dockerHubInfo.repository)
  .then(function(buildSettings) {

    // existing build tag, e.g. build failed or hadn't been triggered yet - but build tag setting already exists
    //existingBuildTags = buildSettings.build_tags.filter(onlyTaggedBuildTag);
    existingBuildTags   = findBuildTagsByDetails(buildSettings.build_tags, details);
    if(existingBuildTags.length > 0) {
      // reuse existing build tag (to preserve the Docker Hub build details)
      return;
    }

    return dockerHubApi.createBuildTag(dockerHubInfo.username, dockerHubInfo.repository, details);
  })
  .then(function(createdBuildTag) {

    var buildTag;
    if(existingBuildTags.length > 0) {
      buildTag = existingBuildTags.pop(); // pick out first build tag for reusing, the rest will be cleaned up afterwards
    } else {
      buildTag = createdBuildTag;
    }

    // adjust details/settings to new details/settings
    // method saveBuildTag(...) not implemented yet!)
    // master branch (for 'latest') never requires modification
    //return dockerHubApi.saveBuildTag(dockerHubInfo.username, dockerHubInfo.repository, buildTag.id, details);

    // trigger the build tag
    // as long as the build process is running, triggering is idempotent
    return dockerHubApi.triggerBuild(dockerHubInfo.username, dockerHubInfo.repository, details);
  })
  .then(function() {
    // clean up eventually existing duplicate build tags
    // one build tag had been removed from the array, so this is only the duplicated rest
    if(existingBuildTags && existingBuildTags.length > 0) {
      return Promise.map(existingBuildTags, function(existingBuildTag) {
        return dockerHubApi.deleteBuildTag(dockerHubInfo.username, dockerHubInfo.repository, existingBuildTag.id);
      });
    }
  })
};

/*
// not used until saveBuildTag had been implemented (see above)
  .then(function(ret) {
    // trigger the now adjusted build tag (this luckily won't disrupt already running builds in build history, 
    // so we don't have to leave old build tags in build settings until the regexp issue would have been resolved!)
    console.log('Done');
  })
  .catch(function(err) {
    console.log(err);
  });
};
*/


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

var findTagsByName = function(tags, tagName) {
  return tags.filter(function(tagChecked) {
    return tagChecked.name == tagName;
  });
};
var findBuildsByTagName = function(builds, tagName) {
  return builds.filter(function(buildChecked) {
    return buildChecked.dockertag_name == tagName;
  });
};


dockerHubApi.login(dockerHubAuth.username, dockerHubAuth.password)
.then(function() {

  // note that build history doesn't contain pending builds nor there being a way yet to list pending builds
  // this applies to both, tagged and 'latest' builds

  // for checking tagged builds alone, list of tags can be used
  // for checking 'latest' builds, only buildDetails can be used,
  //   which may be removed when the buildTag settings are removed for 'latest' (master)

  return dockerHubApi.buildHistory(dockerHubInfo.username, dockerHubInfo.repository);
})
.then(function(builds) {

  var checks = [];

  var buildsSortedDesc = builds.sort(byCreatedDateAsc).reverse(); // (desc)

  // - 'latest' build
  var passingBuildsSortedDesc = buildsSortedDesc.filter(isPassingBuild);

  // check only possible using the build history
  // also check whether the 'latest' build is still pending
  var latestBuilds    = findBuildsByTagName(passingBuildsSortedDesc, 'latest');
  var lastLatestBuild = latestBuilds[0];

  checks.push(dockerHubApi.buildDetails(dockerHubInfo.username, dockerHubInfo.repository, lastLatestBuild.build_code)
  .then(function(lastLatestBuildDetails) {
    var lastLatestBuildTagName = tagNameFromBuildDetails(lastLatestBuildDetails)
    if(lastLatestBuildTagName == buildTagName) {

      if(isPendingBuild(lastLatestBuild)) {
        console.log("Last 'latest' build had been already triggered + is pending, skipped.");
        return;
      }

      console.log("Last 'latest' build had been already build, skipped.");
      return;
    }

    // trigger with master branch for 'latest' build
    console.log("Last 'latest' build uses not recent enough build tag (latest: '" + buildTagNameLastLatestBuild + "', last tag: '" + buildTagName + "'.");
    return reuseTagBuild(dockerHubApi, dockerHubInfo.username, dockerHubInfo.repository, {
      name:        'latest',
      source_name: 'master',
      source_type: BUILD_TAG_SOURCE_TYPE_BRANCH
    })
    .then(function() {
      console.log("Triggered 'latest' build with master branch.");
    })
    .catch(function(err) {
      console.log("Error triggering 'latest' build with master branch, error: " + err);
    });
    console.log("Triggered 'latest' build.");

  })
  );


  // - tagged build
  // (check for tagged builds can use tags)

  // only pending builds for checking as tags from successful builds may have been deleted
  var pendingBuildsSortedDesc = buildsSortedDesc.filter(isPendingBuild);

  checks.push(dockerHubApi.tags(dockerHubInfo.username, dockerHubInfo.repository)
  .then(function(tags) {

    var taggedTags = findTagsByName(tags, buildTagName);
    var taggedTag  = taggedTags[0]; // (tags are unique)
    if(taggedTag) {
      console.log("Tagged build '" + buildTagName + "' had been already built, skipped.");
      return;
    }

    // also check whether the tagged build is still pending
    var taggedPendingBuilds    = findBuildsByTagName(pendingBuildsSortedDesc, buildTagName);
    var lastTaggedPendingBuild = taggedPendingBuilds[0];
    if(lastTaggedPendingBuild) {
      console.log("Tagged build '" + buildTagName + "' had been already triggered + is pending, skipped.");
      return;
    }

    // trigger tagged build
    console.log("Tagged build '" + buildTagName + "' hadn't been built yet.");
    return reuseTagBuild(dockerHubApi, dockerHubInfo.username, dockerHubInfo.repository, {
      source_name: buildTagName,
      source_type: BUILD_TAG_SOURCE_TYPE_TAG
     })
     .then(function() {
       console.log("Triggered tagged build with tag '" + buildTagName + "'.");
     })
     .catch(function(err) {
       console.log("Error triggering tagged build with tag '" + buildTagName + "', error: " + err);
     });

  })
  );


  return Promise.all(checks);
})
.then(function() {
  console.log('Done.');
})
.catch(function(err) {
  console.log('Error (g): ' + err);
});


// determines the build tagname from the build details
var tagNameFromBuildDetails = function(buildDetails) {

  var dockerfile = buildDetails.build_results.dockerfile_contents;
  var version    = getVersionFromDockerfile(dockerfile);
  var sha        = getCommitShaFromDockerfile(dockerfile);

  var nightlyVersion = nightlyVersionStr(version, sha);
  var buildTagName   = getBuildTagName(nightlyVersion);

  return buildTagName;
};
