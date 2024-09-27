// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title Callback for IApi3ServerV1OevExtension#payOevBid
/// @notice Any contract that calls IApi3ServerV1OevExtension#payOevBid must implement this interface
interface IApi3ServerV1OevExtensionPayOevBidCallback {
    /// @notice Called to `msg.sender` after granting the privilege to execute updates for the dApp from IApi3ServerV1OevExtension#payOevBid.
    /// @dev In the implementation you must repay the server the tokens owed for the payment of the OEV bid.
    /// The implementation is responsible to check that the caller of this method is the correct Api3ServerV1OevExtension.
    /// @param amountOwed The amount of tokens owed to the server for the payment of the OEV bid
    /// @param data Any data passed through by the caller via the IApi3ServerV1OevExtension#payOevBid call
    function api3ServerV1OevExtensionPayOevBidCallback(
        uint256 amountOwed,
        bytes calldata data
    ) external;
}
