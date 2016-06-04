var dockerHubApi = require('docker-hub-api'), // (supports promises)
    moment       = require('moment'),
    Promise      = require('bluebird'),
    helper       = require('./helper');

/*
var dockerHubAuth = require('./config/docker-hub-auth');

var config        = require('./config/config');
var dockerHubInfo = {
  username:   config.downstream.dockerhub.user,
  repository: config.downstream.dockerhub.repo
};
*/

// test
// var buildTagName  = 'build-1.6-nightly-5fea2ccc77eb50a9704fa04b7c61755fe34e1d95';


const BUILD_STATUS_SUCCEEDED       = 10;
const BUILD_STATUS_FAILED          = -1;
const BUILD_STATUS_QUEUED          =  0;
const BUILD_STATUS_BUILDING        =  3;

const BUILD_TAG_SOURCE_TYPE_TAG    = 'Tag';
const BUILD_TAG_SOURCE_TYPE_BRANCH = 'Branch';


var isQueuedBuild   = function(build) {
  return (build.status == BUILD_STATUS_QUEUED);
};
var isBuildingBuild = function(build) {
  return (build.status == BUILD_STATUS_BUILDING);
};
var isSucceedingBuild = function(build) {
  return (build.status == BUILD_STATUS_SUCCEEDED);
};

// pending build = either queued or building, not failed nor succeeded (yet)
var isPendingBuild = function(build) {
  return (isQueuedBuild(build) || isBuildingBuild(build));
};
// passing build = either successful or pending, not failed
var isPassingBuild = function(build) {
  return (isPendingBuild(build) || isSucceedingBuild(build));
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


var dockerfileFromBuildDetails = function(buildDetails) {
  if(buildDetails === undefined) {
    throw('build details undefined');
    return false;
  }
  var buildResults = buildDetails.build_results;
  if(buildResults === undefined) {
    throw('build_results missing for given build details.');
    return false;
  }
  var dockerfile = buildResults.dockerfile_contents;
  if(dockerfile.length == 0 || dockerfile === undefined) {
    throw('Dockerfile undefined for given build details, build probably pending.');
    return false;
  }
  return dockerfile;
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


// determines the build tagname from the build details
var tagNameFromBuildDetails = function(buildDetails) {

  var dockerfile = dockerfileFromBuildDetails(buildDetails);
  var version    = getVersionFromDockerfile(dockerfile);
  var sha        = getCommitShaFromDockerfile(dockerfile);

  var nightlyVersion = helper.nightlyVersionStr(version, sha);
  var buildTagName   = helper.getBuildTagName(nightlyVersion);

  return buildTagName;
};


var reuseTagBuild       = function(username, repository, details) {
  var existingBuildTags = {};

  return dockerHubApi.buildSettings(username, repository)
  .then(function(buildSettings) {

    // existing build tag, e.g. build failed or hadn't been triggered yet - but build tag setting already exists
    //existingBuildTags = buildSettings.build_tags.filter(onlyTaggedBuildTag);
    existingBuildTags   = findBuildTagsByDetails(buildSettings.build_tags, details);
    if(existingBuildTags.length > 0) {
      // reuse existing build tag (to preserve the Docker Hub build details)
      return;
    }

    return dockerHubApi.createBuildTag(username, repository, details);
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
    //return dockerHubApi.saveBuildTag(username, repository, buildTag.id, details);

    // trigger the build tag
    // as long as the build process is running, triggering is idempotent
    return dockerHubApi.triggerBuild(username, repository, details);
  })
  .then(function() {
    // clean up eventually existing duplicate build tags
    // one build tag had been removed from the array, so this is only the duplicated rest
    if(existingBuildTags && existingBuildTags.length > 0) {
      return Promise.map(existingBuildTags, function(existingBuildTag) {
        return dockerHubApi.deleteBuildTag(username, repository, existingBuildTag.id);
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


const CHECK_BUILD_OK         =  10;
const CHECK_BUILD_OK_QUEUED  =   3; // (open issue with queued builds having no dockerfile_contents)
const CHECK_BUILD_OK_PENDING =   2;
const CHECK_BUILD_NOTFOUND   =  -1;
const CHECK_BUILD_DIFFER     =  -2;


var handleLatestBuild = function(username, repository, buildsSortedDesc, buildTagName) {
  return checkLatestBuild(username, repository, buildsSortedDesc, buildTagName)
  .then(function(result) {
    if(result.status == CHECK_BUILD_OK || result.status == CHECK_BUILD_OK_PENDING || result.status == CHECK_BUILD_OK_QUEUED) {
      if(result.status == CHECK_BUILD_OK_QUEUED) {
        console.log("Open Dockerhub API issue: Queued builds have no dockerfile_contents field. It isn't possible to determine nightly version, skipped.");
        return;
      }
      if(result.status == CHECK_BUILD_OK_PENDING) {
        console.log("Last 'latest' build had been already triggered + is pending, skipped.");
        return;
      }
      console.log("Last 'latest' build had been already build, skipped.");
      return;
    }
    // Trigger with master branch for 'latest' build
    console.log("Last 'latest' build uses not recent enough build tag (latest: '" + result.latestBuildTagName + "', last tag: '" + buildTagName + "'.");
    // explicitly specify the source tag to ensure last commit is the right one
    return triggerTaggedBuild(username, repository, buildTagName, 'latest');
  });
};


// currently unused
var triggerLatestBuild = function(username, repository) {
  return reuseTagBuild(username, repository, {
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
};

var handleTaggedBuild = function(username, repository, buildsSortedDesc, buildTagName) {
  return checkTaggedBuild(username, repository, buildsSortedDesc, buildTagName)
  .then(function(result) {
    if(result.status == CHECK_BUILD_OK || result.status == CHECK_BUILD_OK_PENDING) {
      if(result.status == CHECK_BUILD_OK_PENDING) {
        //console.log("Tagged build '" + buildTagName + "' had been already triggered + is pending, skipped.");
        return;
      }
      console.log("Tagged build '" + buildTagName + "' had been already built, skipped.");
      return;
    }
    // Trigger tagged build
    console.log("Tagged build '" + buildTagName + "' hadn't been built yet.");
    return triggerTaggedBuild(username, repository, buildTagName);
  });
};

var triggerTaggedBuild = function(username, repository, repoTagName, dockerTagName) {
  return reuseTagBuild(username, repository, {
    name:        dockerTagName,
    source_name: repoTagName,
    source_type: BUILD_TAG_SOURCE_TYPE_TAG
  })
  .then(function() {
    console.log("Triggered tagged build '" + dockerTagName + "' with tag '" + repoTagName + "'.");
  })
  .catch(function(err) {
    console.log("Error triggering tagged build '" + dockerTagName + "' with tag '" + repoTagName + "', error: " + err);
  });
};

var checkLatestBuild = function(username, repository, buildsSortedDesc, buildTagName) {
  // - 'latest' build
  var passingBuildsSortedDesc = buildsSortedDesc.filter(isPassingBuild);

  // check only possible using the build history
  // also check whether the 'latest' build is still pending
  var latestBuilds    = findBuildsByTagName(passingBuildsSortedDesc, 'latest');
  var lastLatestBuild = latestBuilds[0];

  return dockerHubApi.buildDetails(username, repository, lastLatestBuild.build_code)
  .then(function(lastLatestBuildDetails) {
    var lastLatestBuildTagName = tagNameFromBuildDetails(lastLatestBuildDetails)
    if(lastLatestBuildTagName == buildTagName) {

      if(isQueuedBuild(lastLatestBuild)) {
        console.log('pending (queued)');
        return { status: CHECK_BUILD_OK_QUEUED };
      }

      if(isPendingBuild(lastLatestBuild)) {
        console.log('pending (building)');
        return { status: CHECK_BUILD_OK_PENDING };
      }

      return { status: CHECK_BUILD_OK };
    }

    return { status: CHECK_BUILD_DIFFER, latestBuildTagName: lastLatestBuildTagName };
  })
};

var checkTaggedBuild = function(username, repository, buildsSortedDesc, buildTagName) {
  // - tagged build
  // (check for tagged builds can use tags)

  // only pending builds for checking as tags from successful builds may have been deleted
  var pendingBuildsSortedDesc = buildsSortedDesc.filter(isPendingBuild);

  return dockerHubApi.tags(username, repository)
  .then(function(tags) {

    var taggedTags = findTagsByName(tags, buildTagName);
    var taggedTag  = taggedTags[0]; // (tags are unique)
    if(taggedTag) {
      return { status: CHECK_BUILD_OK };
    }

    // also check whether the tagged build is still pending
    var taggedPendingBuilds    = findBuildsByTagName(pendingBuildsSortedDesc, buildTagName);
    var lastTaggedPendingBuild = taggedPendingBuilds[0];
    if(lastTaggedPendingBuild) {
      return { status: CHECK_BUILD_OK_PENDING };
    }

    return { status: CHECK_BUILD_NOTFOUND };
  })
};


var handleRepository = function(dockerHubAuth, dockerHubInfo, buildTagName) {

  return dockerHubApi.login(dockerHubAuth.username, dockerHubAuth.password)
  .then(function() {

    // note that build history doesn't contain pending builds nor there being a way yet to list pending builds
    // this applies to both, tagged and 'latest' builds

    // for checking tagged builds alone, list of tags can be used
    // for checking 'latest' builds, only buildDetails can be used,
    //   which may be removed when the buildTag settings are removed for 'latest' (master)

    return dockerHubApi.buildHistory(dockerHubInfo.username, dockerHubInfo.repository);
  })
  .then(function(builds) {

    var buildsSortedDesc = builds.sort(byCreatedDateAsc).reverse(); // (desc)

    return Promise.all([
      handleLatestBuild(dockerHubInfo.username, dockerHubInfo.repository, buildsSortedDesc, buildTagName),
      handleTaggedBuild(dockerHubInfo.username, dockerHubInfo.repository, buildsSortedDesc, buildTagName)
    ]);
  });

};

module.exports.handleRepository = handleRepository;
