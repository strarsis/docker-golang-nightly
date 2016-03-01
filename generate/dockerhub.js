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
var buildTagName  = 'build-1.6-nightly-50674532719cad7bbdbcce5027f3510633eeed73';


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
const BUILD_TAG_SOURCE_TYPE_TAG    = 'Tag';
const BUILD_TAG_SOURCE_TYPE_BRANCH = 'Branch';


var bySuccessfulBuild = function(build) {
  return (build.status == BUILD_STATUS_SUCCEEDED);
};
var byPendingBuild = function(build) {
  return (build.status == BUILD_STATUS_PENDING);
};


var byUsingTag = function(buildTag) {
  return (buildTag.source_type == BUILD_TAG_SOURCE_TYPE_TAG && buildTag.source_name.match(/build-*/));
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


dockerHubApi.login(dockerHubAuth.username, dockerHubAuth.password)
.then(function() {

  // note that build history doesn't contain pending builds nor there being a way yet to list pending builds
  // this applies to both, tagged and 'latest' builds

  // for checking tagged builds alone, list of tags can be used
  // for checking 'latest' builds, only buildDetails can be used,
  //   which may be removed when the buildTag settings are removed for 'latest' (master)

  return Promise.join(

    fetchLastLatestBuildTagname(dockerHubApi, dockerHubInfo.username, dockerHubInfo.repository)
    .then(function(buildTagNameLastLatestBuild) {


      // Note: building 'latest' only makes sense with the most recent build tag name,
      //       - it wouldn't make sense building 'latest' for past build tag names.
      if(buildTagNameLastLatestBuild == buildTagName) {
        console.log("Last 'latest' build had already been built, skipped.");
        return;
      }

      console.log("Last 'latest' build uses not recent enough build tag (latest: '" + buildTagNameLastLatestBuild + "', last tag: '" + buildTagName + "'.");
      // trigger with master branch for 'latest' build
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

    }),

    fetchLastTaggedBuildTagname(dockerHubApi, dockerHubInfo.username, dockerHubInfo.repository)
    .then(function(existingTag) {

      if(existingTag) {
        console.log("Tag '" + buildTagName + "' had been already built.");
        return;
      }
      console.log("Tag '" + buildTagName + "' hadn't been built yet.");

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
})
.then(function() {
  console.log('Done.');
})
.catch(function(err) {
  console.log('Error (g): ' + err);
});


var fetchLastLatestBuildTagname = function(dockerHubApi, username, repository) {
  console.log('  1/3');
  return dockerHubApi.buildHistory(username, repository)
  .then(function(builds) {
    console.log('  2/3');
    var buildsSorted     = builds.sort(byCreatedDateAsc);
    var qualBuildsSorted = buildsSorted.filter(bySuccessfulBuild);

    // - the last 'latest' build
    var successfulPastLatestBuilds = qualBuildsSorted.filter(function(build) {
      return (build.dockertag_name == 'latest');
    });

    // determine the build tag of the last 'latest' build
    var successfulPastLastLatestBuild = successfulPastLatestBuilds[ successfulPastLatestBuilds.length-1 ];
    return dockerHubApi.buildDetails(username, repository, successfulPastLastLatestBuild.build_code)
  })
  .then(function(buildDetails) {
    console.log('  3/3');
    var dockerfileLastLatestBuild = buildDetails.build_results.dockerfile_contents;
    var versionLastLatestBuild    = getVersionFromDockerfile(dockerfileLastLatestBuild);
    var shaLastLatestBuild        = getCommitShaFromDockerfile(dockerfileLastLatestBuild);

    var nightlyVersionLastLatestBuild = nightlyVersionStr(versionLastLatestBuild, shaLastLatestBuild);
    var buildTagNameLastLatestBuild   = getBuildTagName(nightlyVersionLastLatestBuild);

    return buildTagNameLastLatestBuild;
  });
};

var fetchLastTaggedBuildTagname = function(dockerHubApi, username, repository) {
  return dockerHubApi.tags(username, repository)
  .then(function(tags) {
    var existingTags = tags.filter(function(tag) {
      return tag.name == buildTagName;
    });
    return existingTags;
  });
};
