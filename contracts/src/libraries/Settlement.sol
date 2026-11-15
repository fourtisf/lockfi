// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice Paying and collecting currency deltas inside a PoolManager unlock.
/// @dev Every Tidewell contract settles the same way, so it lives in one place
///      an auditor reads once.
library Settlement {
    /// @notice Pay `amount` of `currency` that the caller owes the PoolManager.
    /// @param payer Who the tokens come from: this contract, or an address that
    ///        approved this contract. Native ETH is always paid from this
    ///        contract's own balance (the value sent with the outer call).
    function pay(IPoolManager manager, Currency currency, address payer, uint256 amount) internal {
        if (amount == 0) return;
        if (currency.isAddressZero()) {
            manager.settle{value: amount}();
            return;
        }
        manager.sync(currency);
        if (payer == address(this)) {
            SafeTransferLib.safeTransfer(ERC20(Currency.unwrap(currency)), address(manager), amount);
        } else {
            SafeTransferLib.safeTransferFrom(ERC20(Currency.unwrap(currency)), payer, address(manager), amount);
        }
        manager.settle();
    }

    /// @notice Collect `amount` of `currency` the PoolManager owes, to `to`.
    function collect(IPoolManager manager, Currency currency, address to, uint256 amount) internal {
        if (amount == 0) return;
        manager.take(currency, to, amount);
    }
}
