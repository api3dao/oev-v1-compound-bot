// https://github.com/GoogleChromeLabs/jsbi/issues/30#issuecomment-953187833
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
