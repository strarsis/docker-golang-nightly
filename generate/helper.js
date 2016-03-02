
var nightlyVersionStr = function(version, sha) {
  return [ version, '-nightly-', sha ].join('');
};

var buildTagPrefix = 'build-';
var getBuildTagName = function(version) {
  return buildTagPrefix + version;
};

module.exports.nightlyVersionStr = nightlyVersionStr;
module.exports.buildTagPrefix    = buildTagPrefix;
module.exports.getBuildTagName   = getBuildTagName;
