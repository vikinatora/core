// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {BaseExchangeModule} from "./BaseExchangeModule.sol";
import {BaseModule} from "../BaseModule.sol";
import {ISeaport} from "../../../interfaces/ISeaport.sol";

// Notes on the Seaport module:
// - supports filling listings (both ERC721/ERC1155)
// - supports filling offers (both ERC721/ERC1155)
// - TODO: integrate order validation

contract SeaportModule is BaseExchangeModule {
    // --- Structs ---

    // Helper struct for avoiding "Stack too deep" errors
    struct SeaportFulfillments {
        ISeaport.FulfillmentComponent[][] offer;
        ISeaport.FulfillmentComponent[][] consideration;
    }

    // --- Fields ---

    address public constant EXCHANGE =
        0x00000000006c3852cbEf3e08E8dF289169EdE581;

    // --- Constructor ---

    constructor(address owner, address router)
        BaseModule(owner)
        BaseExchangeModule(router)
    {}

    // --- Fallback ---

    receive() external payable {}

    // --- Single ETH listing ---

    function acceptETHListing(
        ISeaport.AdvancedOrder calldata order,
        ETHListingParams calldata params,
        Fee[] calldata fees
    )
        external
        payable
        nonReentrant
        refundETHLeftover(params.refundTo)
        chargeETHFees(fees, params.amount)
    {
        // Execute the fill
        params.revertIfIncomplete
            ? _fillSingleOrderWithRevertIfIncomplete(
                order,
                new ISeaport.CriteriaResolver[](0),
                params.fillTo,
                params.amount
            )
            : _fillSingleOrder(
                order,
                new ISeaport.CriteriaResolver[](0),
                params.fillTo,
                params.amount
            );
    }

    // --- Single ERC20 listing ---

    function acceptERC20Listing(
        ISeaport.AdvancedOrder calldata order,
        ERC20ListingParams calldata params,
        Fee[] calldata fees
    )
        external
        nonReentrant
        refundERC20Leftover(params.refundTo, params.token)
        chargeERC20Fees(fees, params.token, params.amount)
    {
        // Approve the exchange if needed
        _approveERC20IfNeeded(params.token, EXCHANGE, params.amount);

        // Execute the fill
        params.revertIfIncomplete
            ? _fillSingleOrderWithRevertIfIncomplete(
                order,
                new ISeaport.CriteriaResolver[](0),
                params.fillTo,
                0
            )
            : _fillSingleOrder(
                order,
                new ISeaport.CriteriaResolver[](0),
                params.fillTo,
                0
            );
    }

    // --- Multiple ETH listings ---

    function acceptETHListings(
        ISeaport.AdvancedOrder[] calldata orders,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        SeaportFulfillments memory fulfillments,
        ETHListingParams calldata params,
        Fee[] calldata fees
    )
        external
        payable
        nonReentrant
        refundETHLeftover(params.refundTo)
        chargeETHFees(fees, params.amount)
    {
        // Execute the fill
        params.revertIfIncomplete
            ? _fillMultipleOrdersWithRevertIfIncomplete(
                orders,
                new ISeaport.CriteriaResolver[](0),
                fulfillments,
                params.fillTo,
                params.amount
            )
            : _fillMultipleOrders(
                orders,
                new ISeaport.CriteriaResolver[](0),
                fulfillments,
                params.fillTo,
                params.amount
            );
    }

    // --- Multiple ERC20 listings ---

    function acceptERC20Listings(
        ISeaport.AdvancedOrder[] calldata orders,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        SeaportFulfillments memory fulfillments,
        ERC20ListingParams calldata params,
        Fee[] calldata fees
    )
        external
        nonReentrant
        refundERC20Leftover(params.refundTo, params.token)
        chargeERC20Fees(fees, params.token, params.amount)
    {
        // Approve the exchange if needed
        _approveERC20IfNeeded(params.token, EXCHANGE, params.amount);

        // Execute the fill
        params.revertIfIncomplete
            ? _fillMultipleOrdersWithRevertIfIncomplete(
                orders,
                new ISeaport.CriteriaResolver[](0),
                fulfillments,
                params.fillTo,
                0
            )
            : _fillMultipleOrders(
                orders,
                new ISeaport.CriteriaResolver[](0),
                fulfillments,
                params.fillTo,
                0
            );
    }

    // --- Single ERC721 offer ---

    function acceptERC721Offer(
        ISeaport.AdvancedOrder calldata order,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        ISeaport.CriteriaResolver[] memory criteriaResolvers,
        OfferParams calldata params
    ) external nonReentrant {
        // Extract the token from the consideration items
        ISeaport.ConsiderationItem calldata item = order
            .parameters
            .consideration[0];
        if (
            item.itemType != ISeaport.ItemType.ERC721 &&
            item.itemType != ISeaport.ItemType.ERC721_WITH_CRITERIA
        ) {
            revert WrongParams();
        }

        IERC721 token = IERC721(item.token);

        // Approve the exchange if needed
        _approveERC721IfNeeded(token, EXCHANGE);

        // Execute the fill
        params.revertIfIncomplete
            ? _fillSingleOrderWithRevertIfIncomplete(
                order,
                criteriaResolvers,
                params.fillTo,
                0
            )
            : _fillSingleOrder(order, criteriaResolvers, params.fillTo, 0);

        // Refund any ERC721 leftover
        _sendAllERC721(params.refundTo, token, item.identifierOrCriteria);
    }

    // --- Single ERC1155 offer ---

    function acceptERC1155Offer(
        ISeaport.AdvancedOrder calldata order,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        ISeaport.CriteriaResolver[] memory criteriaResolvers,
        OfferParams calldata params
    ) external nonReentrant {
        // Extract the token from the consideration items
        ISeaport.ConsiderationItem calldata item = order
            .parameters
            .consideration[0];
        if (
            item.itemType != ISeaport.ItemType.ERC1155 &&
            item.itemType != ISeaport.ItemType.ERC1155_WITH_CRITERIA
        ) {
            revert WrongParams();
        }

        IERC1155 token = IERC1155(item.token);

        // Approve the exchange if needed
        _approveERC1155IfNeeded(token, EXCHANGE);

        // Execute the fill
        params.revertIfIncomplete
            ? _fillSingleOrderWithRevertIfIncomplete(
                order,
                criteriaResolvers,
                params.fillTo,
                0
            )
            : _fillSingleOrder(order, criteriaResolvers, params.fillTo, 0);

        // Refund any ERC1155 leftover
        _sendAllERC1155(params.refundTo, token, item.identifierOrCriteria);
    }

    // --- Generic handler (used for Seaport-based approvals) ---

    function matchOrders(
        ISeaport.Order[] calldata orders,
        ISeaport.Fulfillment[] calldata fulfillments
    ) external nonReentrant {
        // We don't perform any kind of input or return value validation,
        // so this function should be used with precaution - the official
        // way to use it is only for Seaport-based approvals
        ISeaport(EXCHANGE).matchOrders(orders, fulfillments);
    }

    // --- ERC721 / ERC1155 hooks ---

    // Single token offer acceptance can be done approval-less by using the
    // standard `safeTransferFrom` method together with specifying data for
    // further contract calls. An example:
    // `safeTransferFrom(
    //      0xWALLET,
    //      0xMODULE,
    //      TOKEN_ID,
    //      0xABI_ENCODED_ROUTER_EXECUTION_CALLDATA_FOR_OFFER_ACCEPTANCE
    // )`

    function onERC721Received(
        address, // operator,
        address, // from
        uint256, // tokenId,
        bytes calldata data
    ) external returns (bytes4) {
        if (data.length > 0) {
            _makeCall(router, data, 0);
        }

        return this.onERC721Received.selector;
    }

    function onERC1155Received(
        address, // operator
        address, // from
        uint256, // tokenId
        uint256, // amount
        bytes calldata data
    ) external returns (bytes4) {
        if (data.length > 0) {
            _makeCall(router, data, 0);
        }

        return this.onERC1155Received.selector;
    }

    // --- Internal ---

    // NOTE: In lots of cases, Seaport will not revert if fills were not
    // fully executed. An example of that is partial filling, which will
    // successfully fill any amount that is still available (including a
    // zero amount). One way to ensure that we revert in case of partial
    // executions is to check the order's filled amount before and after
    // we trigger the fill (we can use Seaport's `getOrderStatus` method
    // to check). Since this can be expensive in terms of gas, we have a
    // separate method variant to be called when reverts are enabled.

    function _fillSingleOrder(
        ISeaport.AdvancedOrder calldata order,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        ISeaport.CriteriaResolver[] memory criteriaResolvers,
        address receiver,
        uint256 value
    ) internal {
        // Execute the fill
        try
            ISeaport(EXCHANGE).fulfillAdvancedOrder{value: value}(
                order,
                criteriaResolvers,
                bytes32(0),
                receiver
            )
        {} catch {}
    }

    function _fillSingleOrderWithRevertIfIncomplete(
        ISeaport.AdvancedOrder calldata order,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        ISeaport.CriteriaResolver[] memory criteriaResolvers,
        address receiver,
        uint256 value
    ) internal {
        // Cache the order's hash
        bytes32 orderHash = _getOrderHash(order.parameters);

        // Before filling, get the order's filled amount
        uint256 beforeFilledAmount = _getFilledAmount(orderHash);

        // Execute the fill
        bool success;
        try
            ISeaport(EXCHANGE).fulfillAdvancedOrder{value: value}(
                order,
                criteriaResolvers,
                bytes32(0),
                receiver
            )
        returns (bool fulfilled) {
            success = fulfilled;
        } catch {
            revert UnsuccessfulFill();
        }

        if (!success) {
            revert UnsuccessfulFill();
        } else {
            // After successfully filling, get the order's filled amount
            uint256 afterFilledAmount = _getFilledAmount(orderHash);

            // Make sure the amount filled as part of this call is correct
            if (afterFilledAmount - beforeFilledAmount != order.numerator) {
                revert UnsuccessfulFill();
            }
        }
    }

    function _fillMultipleOrders(
        ISeaport.AdvancedOrder[] calldata orders,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        ISeaport.CriteriaResolver[] memory criteriaResolvers,
        SeaportFulfillments memory fulfillments,
        address receiver,
        uint256 value
    ) internal {
        // Execute the fill
        ISeaport(EXCHANGE).fulfillAvailableAdvancedOrders{value: value}(
            orders,
            criteriaResolvers,
            fulfillments.offer,
            fulfillments.consideration,
            bytes32(0),
            receiver,
            // Assume at most 255 orders can be filled at once
            0xff
        );
    }

    function _fillMultipleOrdersWithRevertIfIncomplete(
        ISeaport.AdvancedOrder[] calldata orders,
        // Use `memory` instead of `calldata` to avoid `Stack too deep` errors
        ISeaport.CriteriaResolver[] memory criteriaResolvers,
        SeaportFulfillments memory fulfillments,
        address receiver,
        uint256 value
    ) internal {
        uint256 length = orders.length;

        bytes32[] memory orderHashes = new bytes32[](length);
        uint256[] memory beforeFilledAmounts = new uint256[](length);
        {
            for (uint256 i = 0; i < length; ) {
                // Cache each order's hashes
                orderHashes[i] = _getOrderHash(orders[i].parameters);
                // Before filling, get each order's filled amount
                beforeFilledAmounts[i] = _getFilledAmount(orderHashes[i]);

                unchecked {
                    ++i;
                }
            }
        }

        // Execute the fill
        (bool[] memory fulfilled, ) = ISeaport(EXCHANGE)
            .fulfillAvailableAdvancedOrders{value: value}(
            orders,
            criteriaResolvers,
            fulfillments.offer,
            fulfillments.consideration,
            bytes32(0),
            receiver,
            // Assume at most 255 orders can be filled at once
            0xff
        );

        for (uint256 i = 0; i < length; ) {
            // After successfully filling, get the order's filled amount
            uint256 afterFilledAmount = _getFilledAmount(orderHashes[i]);

            // Make sure the amount filled as part of this call is correct
            if (
                fulfilled[i] &&
                afterFilledAmount - beforeFilledAmounts[i] !=
                orders[i].numerator
            ) {
                fulfilled[i] = false;
            }

            if (!fulfilled[i]) {
                revert UnsuccessfulFill();
            }

            unchecked {
                ++i;
            }
        }
    }

    function _getOrderHash(
        // Must use `memory` instead of `calldata` for the below cast
        ISeaport.OrderParameters memory orderParameters
    ) internal view returns (bytes32 orderHash) {
        // `OrderParameters` and `OrderComponents` share the exact same
        // fields, apart from the last one, so here we simply treat the
        // `orderParameters` argument as `OrderComponents` and then set
        // the last field to the correct data
        ISeaport.OrderComponents memory orderComponents;
        assembly {
            orderComponents := orderParameters
        }
        orderComponents.counter = ISeaport(EXCHANGE).getCounter(
            orderParameters.offerer
        );

        orderHash = ISeaport(EXCHANGE).getOrderHash(orderComponents);
    }

    function _getFilledAmount(bytes32 orderHash)
        internal
        view
        returns (uint256 totalFilled)
    {
        (, , totalFilled, ) = ISeaport(EXCHANGE).getOrderStatus(orderHash);
    }
}
