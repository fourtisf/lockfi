// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @notice The subset of WETH9 (aeWETH on Robinhood Chain) Tidewell uses.
interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
