function isEnabledConfigValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function getInactiveGoogleSyncAmoids(existingGoogleMethods, authMethods) {
  const activeGoogleSyncAmoids = authMethods
    .filter(
      method =>
        method.type == 'google' &&
        !isEnabledConfigValue(method.isDisabled) &&
        isEnabledConfigValue(method.googleSyncRoles)
    )
    .map(method => method.amoid);

  return existingGoogleMethods.map(method => method.amoid).filter(amoid => !activeGoogleSyncAmoids.includes(amoid));
}

module.exports = {
  isEnabledConfigValue,
  getInactiveGoogleSyncAmoids,
};
