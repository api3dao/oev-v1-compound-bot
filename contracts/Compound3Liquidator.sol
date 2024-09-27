// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { IComet } from './compound3/interfaces/IComet.sol';
import { IUniswapV3FlashCallback } from './uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol';
import { IUniswapV3SwapCallback } from './uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol';
import { IUniswapV3Pool } from './uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol';
import { TickMath } from './uniswap/v3-core/contracts/libraries/TickMath.sol';
import { PoolAddress } from './uniswap/v3-periphery/contracts/libraries/PoolAddress.sol';
import { CallbackValidation } from './uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol';
import { TransferHelper } from './uniswap/v3-periphery/contracts/libraries/TransferHelper.sol';
import { IWETH9 } from './uniswap/v3-periphery/contracts/interfaces/external/IWETH9.sol';
import { ISwapRouter02 } from './uniswap/swap-router-contracts/contracts/interfaces/ISwapRouter02.sol';
import { IV3SwapRouter } from './uniswap/swap-router-contracts/contracts/interfaces/IV3SwapRouter.sol';
import { IApi3ServerV1OevExtension } from './api3-contracts/api3-server-v1/interfaces/IApi3ServerV1OevExtension.sol';

event AbsorbFailed(address indexed borrower);

contract Compound3Liquidator is Ownable, IUniswapV3SwapCallback, IUniswapV3FlashCallback {
  address public profitReceiver;
  uint24 public constant DEFAULT_POOL_FEE = 500; // 0.05%
  uint256 public constant DAPP_ID = 1;
  uint256 public constant QUOTE_PRICE_SCALE = 1e18;
  address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
  address public constant WETH = 0x4200000000000000000000000000000000000006;
  address public constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
  address public constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
  address public constant UNISWAP_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
  address public constant API3_SERVER_V1_OEV_EXTENSION = 0xF930D1E37098128326F8731a476347f0840337cA;

  mapping(address => mapping(address => uint24)) public uniswapPoolFees;

  IComet public comet;
  IWETH9 weth = IWETH9(WETH);
  ISwapRouter02 swapRouter = ISwapRouter02(SWAP_ROUTER);
  IApi3ServerV1OevExtension oevExtension = IApi3ServerV1OevExtension(API3_SERVER_V1_OEV_EXTENSION);

  struct LiquidateParams {
    address[] liquidatableAccounts;
    uint256[] maxAmountsToPurchase;
    uint256 liquidationThreshold;
    uint32 signedDataTimestampCutoff;
    bytes signature;
    uint256 bidValue;
    bytes[][] signedDataArray;
  }

  struct FlashCallbackData {
    PoolAddress.PoolKey poolKey;
    LiquidateParams params;
  }

  struct SwapCallbackData {
    PoolAddress.PoolKey poolKey;
    address[] assets;
    uint256[] assetBaseAmounts;
  }

  constructor(address initialProfitReceiver, address _comet) Ownable(msg.sender) {
    profitReceiver = initialProfitReceiver == address(0) ? msg.sender : initialProfitReceiver;
    comet = IComet(_comet);
    uniswapPoolFees[WETH][WSTETH] = 100;
    uniswapPoolFees[WSTETH][WETH] = 100;
  }

  // https://github.com/compound-finance/comet/blob/f41fec9858ae7e53be6cde96c74c3fa16782fa2a/contracts/Comet.sol#L736
  function isInAsset(uint16 assetsIn, uint8 assetOffset) internal pure returns (bool) {
    return (assetsIn & (uint16(1) << assetOffset) != 0);
  }

  /// @notice Gets the account details for the accounts provided. The functions
  /// mirrors the logic of
  /// https://github.com/compound-finance/comet/blob/f41fec9858ae7e53be6cde96c74c3fa16782fa2a/contracts/Comet.sol#L524
  ///
  /// NOTE: The returned numbers are scaled by 10^8.
  /// @param accounts The accounts to get the details for.
  /// @return borrowsUsd The borrows in USD for each account.
  /// @return maxBorrowsUsd The maximum borrows in USD for each account.
  /// @return collateralsUsd The collaterals in USD for each account.
  function getAccountsDetails(
    address[] calldata accounts
  )
    external
    view
    returns (
      uint256[] memory borrowsUsd,
      uint256[] memory maxBorrowsUsd,
      uint256[] memory collateralsUsd,
      bool[] memory areLiquidatable
    )
  {
    // Get info about all of the assets.
    IComet.AssetInfo[] memory assets = new IComet.AssetInfo[](comet.numAssets());
    for (uint8 i; i < comet.numAssets(); ++i) {
      assets[i] = comet.getAssetInfo(i);
    }
    uint256[] memory prices = new uint256[](assets.length);
    for (uint8 i; i < assets.length; ++i) {
      prices[i] = comet.getPrice(assets[i].priceFeed);
    }

    // Compute liquidity for each account.
    borrowsUsd = new uint256[](accounts.length);
    maxBorrowsUsd = new uint256[](accounts.length);
    collateralsUsd = new uint256[](accounts.length);
    areLiquidatable = new bool[](accounts.length);
    for (uint256 accountIndex; accountIndex < accounts.length; ++accountIndex) {
      (, , , uint16 assetsIn, ) = comet.userBasic(accounts[accountIndex]);
      uint256 basePrice = comet.getPrice(comet.baseTokenPriceFeed());
      uint256 baseScale = comet.baseScale();
      // NOTE: This includes interest accruals, but the liquidation does not.
      maxBorrowsUsd[accountIndex] = (comet.balanceOf(accounts[accountIndex]) * basePrice) / baseScale;
      borrowsUsd[accountIndex] = ((comet.borrowBalanceOf(accounts[accountIndex])) * basePrice) / baseScale;

      for (uint8 assetIndex; assetIndex < comet.numAssets(); ) {
        if (isInAsset(assetsIn, assetIndex)) {
          (uint256 colateralBalance, ) = comet.userCollateral(accounts[accountIndex], assets[assetIndex].asset);
          uint256 collateralAmount = (colateralBalance * prices[assetIndex]) / assets[assetIndex].scale;

          maxBorrowsUsd[accountIndex] += (collateralAmount * assets[assetIndex].liquidateCollateralFactor) / 1e18;
          collateralsUsd[accountIndex] += collateralAmount;
        }
        unchecked {
          ++assetIndex;
        }
      }

      // Call the "isLiquidatable" from the Comet contract as a source of truth
      // for determining if the position is liquidatable.
      areLiquidatable[accountIndex] = comet.isLiquidatable(accounts[accountIndex]);
    }
  }

  function liquidate(LiquidateParams calldata params) external returns (uint256, uint256) {
    PoolAddress.PoolKey memory poolKey = _getFlashSwapPoolKey(USDC, WETH);
    IUniswapV3Pool pool = _getFlashSwapPool(poolKey);

    pool.flash(
      address(this),
      params.bidValue, // token0 = WETH
      0, // token1 = USDC
      abi.encode(FlashCallbackData({ poolKey: poolKey, params: params }))
    );

    uint256 wethBalance = weth.balanceOf(address(this));
    if (wethBalance > 0) {
      weth.withdraw(wethBalance);
    }

    uint8 numberOfAssets = comet.numAssets();
    IComet.AssetInfo memory wethAsset;
    for (uint8 i; i < numberOfAssets; ++i) {
      IComet.AssetInfo memory assetInfo = comet.getAssetInfo(i);
      if (assetInfo.asset == WETH) {
        wethAsset = assetInfo;
      }
    }

    uint256 profit = address(this).balance;
    uint256 profitUsd = (profit * comet.getPrice(wethAsset.priceFeed)) / wethAsset.scale;
    profitReceiver.call{ value: profit }('');

    return (profit, profitUsd);
  }

  /// @notice Callback for flash loans through Uniswap V3
  function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata _data) external override {
    FlashCallbackData memory data = abi.decode(_data, (FlashCallbackData));
    CallbackValidation.verifyCallback(UNISWAP_FACTORY, data.poolKey);

    weth.withdraw(data.params.bidValue);

    oevExtension.payOevBid{ value: data.params.bidValue }(
      DAPP_ID,
      data.params.signedDataTimestampCutoff,
      data.params.signature
    );

    _updateDataFeeds(data.params.signedDataArray);

    address[] memory accountToAbsorb = new address[](1);
    for (uint8 i; i < data.params.liquidatableAccounts.length; ++i) {
      accountToAbsorb[0] = data.params.liquidatableAccounts[i];

      try comet.absorb(msg.sender, accountToAbsorb) {} catch {
        emit AbsorbFailed(accountToAbsorb[0]);
      }
    }

    uint8 numberOfAssets = comet.numAssets();
    address[] memory assets = new address[](numberOfAssets);
    for (uint8 i; i < numberOfAssets; ++i) {
      IComet.AssetInfo memory assetInfo = comet.getAssetInfo(i);
      assets[i] = assetInfo.asset;
    }

    uint256 flashSwapAmount;
    uint256[] memory assetBaseAmounts = new uint256[](assets.length);
    for (uint8 i; i < assets.length; ++i) {
      (, uint256 collateralBalanceInBase) = _purchasableBalanceOfAsset(assets[i], data.params.maxAmountsToPurchase[i]);
      if (collateralBalanceInBase > data.params.liquidationThreshold) {
        flashSwapAmount += collateralBalanceInBase;
        assetBaseAmounts[i] = collateralBalanceInBase;
      }
    }

    require(flashSwapAmount > 0, 'No collateral to buy.');

    bool zeroForOne = WETH < USDC; // tokenIn < tokenOut
    PoolAddress.PoolKey memory poolKey = _getFlashSwapPoolKey(USDC, WETH);
    IUniswapV3Pool pool = _getFlashSwapPool(poolKey);

    pool.swap(
      address(this),
      zeroForOne,
      -int256(flashSwapAmount),
      zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
      abi.encode(SwapCallbackData({ poolKey: poolKey, assets: assets, assetBaseAmounts: assetBaseAmounts }))
    );

    weth.transfer(msg.sender, data.params.bidValue + fee0);
  }

  /// @notice Callback for flash swaps through Uniswap V3
  function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata _data) external override {
    uint256 requiredReturnAmount = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
    uint256 receivedAmount = amount0Delta < 0 ? uint256(-amount0Delta) : uint256(-amount1Delta);

    SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
    CallbackValidation.verifyCallback(UNISWAP_FACTORY, data.poolKey);

    address[] memory assets = data.assets;
    address baseToken = comet.baseToken();
    TransferHelper.safeApprove(baseToken, address(comet), receivedAmount);

    uint256 totalAmountOut;
    for (uint i; i < assets.length; ++i) {
      address asset = assets[i];
      uint256 assetBaseAmount = data.assetBaseAmounts[i];

      if (assetBaseAmount == 0) continue;

      comet.buyCollateral(asset, 0, assetBaseAmount, address(this));

      uint256 assetBalance = IERC20(asset).balanceOf(address(this));
      IERC20(asset).approve(SWAP_ROUTER, assetBalance);

      if (asset != WETH) {
        IV3SwapRouter.ExactInputSingleParams memory params = IV3SwapRouter.ExactInputSingleParams({
          tokenIn: asset,
          tokenOut: WETH,
          fee: _getPoolFee(asset, WETH),
          recipient: address(this),
          amountIn: assetBalance,
          amountOutMinimum: 0,
          sqrtPriceLimitX96: 0
        });

        swapRouter.exactInputSingle(params);
      }
    }

    weth.transfer(msg.sender, requiredReturnAmount);
  }

  function _updateDataFeeds(bytes[][] memory signedDataArray) internal {
    uint256 len = signedDataArray.length;
    for (uint256 i; i < len; ++i) {
      oevExtension.updateDappOevDataFeed(DAPP_ID, signedDataArray[i]);
    }
  }

  function _purchasableBalanceOfAsset(
    address asset,
    uint256 maxCollateralToPurchase
  ) internal view returns (uint256, uint256) {
    uint256 collateralBalance = comet.getCollateralReserves(asset);
    collateralBalance = _min(collateralBalance, maxCollateralToPurchase);

    uint256 baseScale = comet.baseScale();
    uint256 quotePrice = comet.quoteCollateral(asset, QUOTE_PRICE_SCALE * baseScale);
    uint256 collateralBalanceInBase = (baseScale * QUOTE_PRICE_SCALE * collateralBalance) / quotePrice;

    return (collateralBalance, collateralBalanceInBase);
  }

  function _getFlashSwapPoolKey(address tokenA, address tokenB) internal view returns (PoolAddress.PoolKey memory) {
    return PoolAddress.getPoolKey(tokenA, tokenB, _getPoolFee(tokenA, tokenB));
  }

  /// @dev Returns the pool for the given token pair and fee. The pool contract may or may not exist.
  function _getFlashSwapPool(PoolAddress.PoolKey memory poolKey) internal pure returns (IUniswapV3Pool) {
    return IUniswapV3Pool(PoolAddress.computeAddress(UNISWAP_FACTORY, poolKey));
  }

  function _getPoolFee(address tokenA, address tokenB) internal view returns (uint24) {
    return uniswapPoolFees[tokenA][tokenB] == 0 ? DEFAULT_POOL_FEE : uniswapPoolFees[tokenA][tokenB];
  }

  function _min(uint256 a, uint256 b) internal pure returns (uint256) {
    return a <= b ? a : b;
  }

  /// @notice Withdraws all tokens to the contract owner.
  /// @param token The address of the token to withdraw.
  function withdrawAllTokens(address token) external onlyOwner {
    uint256 amount = IERC20(token).balanceOf(address(this));
    IERC20(token).transfer(owner(), amount);
  }

  /// @notice Withdraws all ether to the contract owner.
  function withdrawAllEth() external onlyOwner {
    uint256 amount = address(this).balance;
    (bool sent, ) = payable(owner()).call{ value: amount }('');
    require(sent, 'Failed to send Ether!');
  }

  /// @notice Function to set address where bot profits should be forwarded.
  /// @param newProfitReceiver The new address.
  function setProfitReceiverAddress(address newProfitReceiver) external onlyOwner {
    require(newProfitReceiver != address(0), "Address can't be set to 0");
    profitReceiver = newProfitReceiver;
  }

  /// @notice Function to set preferred Uniswap pool fee to swap a given token.
  /// @param token0 Token to set the preferred pool fee for.
  /// @param token1 Token to set the preferred pool fee for.
  /// @param poolFee Value of a preferred pool fee in hundredths of a bip, i.e. 1e-6. If set to 0, a pool with 0.05% fee (DEFAULT_POOL_FEE) will be used by default.
  function setPreferredPoolFee(address token0, address token1, uint24 poolFee) external onlyOwner {
    uniswapPoolFees[token0][token1] = poolFee;
    uniswapPoolFees[token1][token0] = poolFee;
  }

  receive() external payable {}
}
