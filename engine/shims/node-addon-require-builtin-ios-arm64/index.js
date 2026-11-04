'use strict';
// Same surface as the prebuilt binding node-addon-native-custom-loader
// validates. iOS cannot load downloaded addons; with --expose-internals the
// builtin require already resolves internal/* ids, which is all the
// unrestricted variant forwards to.
if (!process.execArgv.includes('--expose-internals')) {
  throw new Error('node-addon-require-builtin-ios-arm64 needs Node started with --expose-internals');
}
module.exports = {
  requireBuiltin: (id) => require(id),
  isAllowedInternalId: () => true,
  getNativeBindingInfo: () => ({ mode: 'napi', product: 'require-builtin', backend: 'napi', abi: 'napi-v9' }),
};
