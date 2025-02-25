import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";

import * as Addresses from "./addresses";
import { ExchangeKind, BidDetails, ListingDetails } from "./types";
import * as Sdk from "../index";
import { TxData, bn, generateReferrerBytes } from "../utils";

import Erc721Abi from "../common/abis/Erc721.json";
import Erc1155Abi from "../common/abis/Erc1155.json";
import RouterAbi from "./abis/ReservoirV5_0_0.json";

export class Router {
  public chainId: number;
  public contract: Contract;
  public provider: Provider;

  constructor(chainId: number, provider: Provider) {
    this.chainId = chainId;
    this.contract = new Contract(
      Addresses.Router[chainId],
      RouterAbi,
      provider
    );
    this.provider = provider;
  }

  public async fillListingsTx(
    details: ListingDetails[],
    taker: string,
    options?: {
      referrer?: string;
      fee?: {
        recipient: string;
        bps: number | string;
      };
      skipPrecheck?: boolean;
      forceRouter?: boolean;
      partial?: boolean;
      directFillingData?: any;
    }
  ): Promise<TxData> {
    // Assume the listing details are consistent with the underlying order object

    // Orders on exchanges that support batch filling will be batch filled
    // natively so that filling is as efficient as possible while the rest
    // of the orders will be filled individually.

    // Native batch filling:
    // - OpenDao
    // - Seaport
    // - X2Y2 (not supported yet)
    // - ZeroExV4

    // If all orders are Seaport, then we fill on Seaport directly
    // TODO: Once the modular router is implemented, a refactoring
    // might be needed - to use the router-generated order instead
    // of treating Seaport as a special case (this is not possible
    // at the moment because the router has separate functions for
    // filling ERC721 vs ERC1155).
    if (
      details.every(({ kind }) => kind === "seaport") &&
      // TODO: Look into using tips for fees on top (only doable on Seaport)
      (!options?.fee || Number(options.fee.bps) === 0) &&
      // Skip direct filling if disabled via the options
      !options?.forceRouter
    ) {
      const exchange = new Sdk.Seaport.Exchange(this.chainId);
      if (details.length === 1) {
        const order = details[0].order as Sdk.Seaport.Order;
        return exchange.fillOrderTx(
          taker,
          order,
          order.buildMatching({ amount: details[0].amount }),
          {
            ...options,
            ...options?.directFillingData,
          }
        );
      } else {
        const orders = details.map((d) => d.order as Sdk.Seaport.Order);
        return exchange.fillOrdersTx(
          taker,
          orders,
          orders.map((order, i) =>
            order.buildMatching({ amount: details[i].amount })
          ),
          {
            ...options,
            ...options?.directFillingData,
          }
        );
      }
    }

    // TODO: Refactor with the new modular router
    if (details.length === 1 && details[0].kind === "cryptopunks") {
      const exchange = new Sdk.CryptoPunks.Exchange(this.chainId);
      return exchange.fillListingTx(taker, details[0].order, options);
    }

    // Ensure all listings are in ETH
    if (
      !details.every(
        (d) => d.currency === Sdk.Common.Addresses.Eth[this.chainId]
      )
    ) {
      throw new Error("Only ETH listings are fillable through the router");
    }

    // Keep track of batch-fillable orders
    const opendaoErc721Details: ListingDetails[] = [];
    const opendaoErc1155Details: ListingDetails[] = [];
    const zeroexV4Erc721Details: ListingDetails[] = [];
    const zeroexV4Erc1155Details: ListingDetails[] = [];
    for (let i = 0; i < details.length; i++) {
      const { kind, contractKind } = details[i];
      switch (kind) {
        case "opendao": {
          (contractKind === "erc721"
            ? opendaoErc721Details
            : opendaoErc1155Details
          ).push(details[i]);
          break;
        }

        case "zeroex-v4": {
          (contractKind === "erc721"
            ? zeroexV4Erc721Details
            : zeroexV4Erc1155Details
          ).push(details[i]);
          break;
        }
      }
    }

    const fee = options?.fee ? options.fee : { recipient: AddressZero, bps: 0 };

    // Keep track of all listings to be filled through the router
    const routerTxs: TxData[] = [];

    // Only batch-fill if there are multiple orders
    if (opendaoErc721Details.length > 1) {
      const exchange = new Sdk.OpenDao.Exchange(this.chainId);
      const tx = exchange.batchBuyTx(
        taker,
        opendaoErc721Details.map((detail) => detail.order as Sdk.OpenDao.Order),
        opendaoErc721Details.map((detail) =>
          (detail.order as Sdk.OpenDao.Order).buildMatching({
            amount: detail.amount ?? 1,
          })
        )
      );

      routerTxs.push({
        from: taker,
        to: this.contract.address,
        data: this.contract.interface.encodeFunctionData(
          "batchERC721ListingFill",
          [
            tx.data,
            opendaoErc721Details.map((detail) => detail.contract),
            opendaoErc721Details.map((detail) => detail.tokenId),
            taker,
            fee.recipient,
            fee.bps,
          ]
        ),
        value: bn(tx.value!)
          .add(bn(tx.value!).mul(fee.bps).div(10000))
          .toHexString(),
      });

      // Delete any batch-filled orders
      details = details.filter(
        ({ kind, contractKind }) =>
          kind !== "opendao" && contractKind !== "erc721"
      );
    }
    if (opendaoErc1155Details.length > 1) {
      const exchange = new Sdk.OpenDao.Exchange(this.chainId);
      const tx = exchange.batchBuyTx(
        taker,
        opendaoErc1155Details.map(
          (detail) => detail.order as Sdk.OpenDao.Order
        ),
        opendaoErc1155Details.map((detail) =>
          (detail.order as Sdk.OpenDao.Order).buildMatching({
            amount: detail.amount ?? 1,
          })
        )
      );

      routerTxs.push({
        from: taker,
        to: this.contract.address,
        data: this.contract.interface.encodeFunctionData(
          "batchERC1155ListingFill",
          [
            tx.data,
            opendaoErc1155Details.map((detail) => detail.contract),
            opendaoErc1155Details.map((detail) => detail.tokenId),
            opendaoErc1155Details.map((detail) => detail.amount ?? 1),
            taker,
            fee.recipient,
            fee.bps,
          ]
        ),
        value: bn(tx.value!)
          .add(bn(tx.value!).mul(fee.bps).div(10000))
          .toHexString(),
      });

      // Delete any batch-filled orders
      details = details.filter(
        ({ kind, contractKind }) =>
          kind !== "opendao" && contractKind !== "erc1155"
      );
    }

    if (zeroexV4Erc721Details.length > 1) {
      const exchange = new Sdk.ZeroExV4.Exchange(this.chainId);
      const tx = exchange.batchBuyTx(
        taker,
        zeroexV4Erc1155Details.map(
          (detail) => detail.order as Sdk.ZeroExV4.Order
        ),
        zeroexV4Erc1155Details.map((detail) =>
          (detail.order as Sdk.ZeroExV4.Order).buildMatching({
            amount: detail.amount ?? 1,
          })
        )
      );

      routerTxs.push({
        from: taker,
        to: this.contract.address,
        data: this.contract.interface.encodeFunctionData(
          "batchERC721ListingFill",
          [
            tx.data,
            zeroexV4Erc721Details.map((detail) => detail.contract),
            zeroexV4Erc721Details.map((detail) => detail.tokenId),
            taker,
            fee.recipient,
            fee.bps,
          ]
        ),
        value: bn(tx.value!)
          .add(bn(tx.value!).mul(fee.bps).div(10000))
          .toHexString(),
      });

      // Delete any batch-filled orders
      details = details.filter(
        ({ kind, contractKind }) =>
          kind !== "zeroex-v4" && contractKind !== "erc721"
      );
    }
    if (zeroexV4Erc1155Details.length > 1) {
      const exchange = new Sdk.ZeroExV4.Exchange(this.chainId);
      const tx = exchange.batchBuyTx(
        taker,
        zeroexV4Erc1155Details.map(
          (detail) => detail.order as Sdk.ZeroExV4.Order
        ),
        zeroexV4Erc1155Details.map((detail) =>
          (detail.order as Sdk.ZeroExV4.Order).buildMatching({
            amount: detail.amount ?? 1,
          })
        )
      );

      routerTxs.push({
        from: taker,
        to: this.contract.address,
        data: this.contract.interface.encodeFunctionData(
          "batchERC1155ListingFill",
          [
            tx.data,
            zeroexV4Erc1155Details.map((detail) => detail.contract),
            zeroexV4Erc1155Details.map((detail) => detail.tokenId),
            zeroexV4Erc1155Details.map((detail) => detail.amount ?? 1),
            taker,
            fee.recipient,
            fee.bps,
          ]
        ),
        value: bn(tx.value!)
          .add(bn(tx.value!).mul(fee.bps).div(10000))
          .toHexString(),
      });

      // Delete any batch-filled orders
      details = details.filter(
        ({ kind, contractKind }) =>
          kind !== "zeroex-v4" && contractKind !== "erc1155"
      );
    }

    // Rest of orders are individually filled
    for (const detail of details) {
      const { tx, exchangeKind, maker, isEscrowed } =
        await this.generateNativeListingFillTx(detail, taker);

      if (detail.contractKind === "erc721") {
        routerTxs.push({
          from: taker,
          to: this.contract.address,
          data:
            !options?.skipPrecheck && !isEscrowed
              ? this.contract.interface.encodeFunctionData(
                  "singleERC721ListingFillWithPrecheck",
                  [
                    tx.data,
                    exchangeKind,
                    detail.contract,
                    detail.tokenId,
                    taker,
                    maker,
                    fee.recipient,
                    fee.bps,
                  ]
                )
              : this.contract.interface.encodeFunctionData(
                  "singleERC721ListingFill",
                  [
                    tx.data,
                    exchangeKind,
                    detail.contract,
                    detail.tokenId,
                    taker,
                    fee.recipient,
                    fee.bps,
                  ]
                ),
          value: bn(tx.value!)
            // Add the referrer fee
            .add(bn(tx.value!).mul(fee.bps).div(10000))
            .toHexString(),
        });
      } else {
        routerTxs.push({
          from: taker,
          to: this.contract.address,
          data:
            !options?.skipPrecheck && !isEscrowed
              ? this.contract.interface.encodeFunctionData(
                  "singleERC1155ListingFillWithPrecheck",
                  [
                    tx.data,
                    exchangeKind,
                    detail.contract,
                    detail.tokenId,
                    detail.amount ?? 1,
                    taker,
                    maker,
                    fee.recipient,
                    fee.bps,
                  ]
                )
              : this.contract.interface.encodeFunctionData(
                  "singleERC1155ListingFill",
                  [
                    tx.data,
                    exchangeKind,
                    detail.contract,
                    detail.tokenId,
                    detail.amount ?? 1,
                    taker,
                    fee.recipient,
                    fee.bps,
                  ]
                ),
          value: bn(tx.value!)
            // Add the referrer fee
            .add(bn(tx.value!).mul(fee.bps).div(10000))
            .toHexString(),
        });
      }
    }

    if (routerTxs.length === 1) {
      return {
        ...routerTxs[0],
        data: routerTxs[0].data + generateReferrerBytes(options?.referrer),
      };
    } else if (routerTxs.length > 1) {
      return {
        from: taker,
        to: this.contract.address,
        data:
          this.contract.interface.encodeFunctionData("multiListingFill", [
            routerTxs.map((tx) => tx.data),
            routerTxs.map((tx) => tx.value!.toString()),
            !options?.partial,
          ]) + generateReferrerBytes(options?.referrer),
        value: routerTxs
          .map((tx) => bn(tx.value!))
          .reduce((a, b) => a.add(b), bn(0))
          .toHexString(),
      };
    } else {
      throw new Error("Could not generate transaction");
    }
  }

  public async fillBidTx(
    detail: BidDetails,
    taker: string,
    options?: {
      referrer?: string;
    }
  ) {
    // Assume the bid details are consistent with the underlying order object

    const { tx, exchangeKind } = await this.generateNativeBidFillTx(
      detail,
      taker
    );

    // The V5 router does not support filling X2Y2 bids, so we fill directly
    if (exchangeKind === ExchangeKind.X2Y2) {
      return {
        from: taker,
        to: Sdk.X2Y2.Addresses.Exchange[this.chainId],
        data: tx.data + generateReferrerBytes(options?.referrer),
      };
    }

    // Wrap the exchange-specific fill transaction via the router
    // (use the `onReceived` hooks for single token filling)
    if (detail.contractKind === "erc721") {
      return {
        from: taker,
        to: detail.contract,
        data:
          new Interface(Erc721Abi).encodeFunctionData(
            "safeTransferFrom(address,address,uint256,bytes)",
            [
              taker,
              this.contract.address,
              detail.tokenId,
              this.contract.interface.encodeFunctionData(
                "singleERC721BidFill",
                [tx.data, exchangeKind, detail.contract, taker, true]
              ),
            ]
          ) + generateReferrerBytes(options?.referrer),
      };
    } else {
      return {
        from: taker,
        to: detail.contract,
        data:
          new Interface(Erc1155Abi).encodeFunctionData(
            "safeTransferFrom(address,address,uint256,uint256,bytes)",
            [
              taker,
              this.contract.address,
              detail.tokenId,
              // TODO: Support selling a quantity greater than 1
              1,
              this.contract.interface.encodeFunctionData(
                "singleERC1155BidFill",
                [tx.data, exchangeKind, detail.contract, taker, true]
              ),
            ]
          ) + generateReferrerBytes(options?.referrer),
      };
    }

    // Direct filling (requires approval):
    // const { tx } = await this.generateNativeBidFillTx(detail, taker, {
    //   noRouter: true,
    // });

    // return {
    //   ...tx,
    //   data: tx.data + generateReferrerBytes(options?.referrer),
    // };
  }

  private async generateNativeListingFillTx(
    { kind, order, tokenId, amount }: ListingDetails,
    taker: string
  ): Promise<{
    tx: TxData;
    exchangeKind: ExchangeKind;
    maker: string;
    isEscrowed?: boolean;
  }> {
    // In all below cases we set the router contract as the taker
    // since forwarding any received token to the actual taker of
    // the order will be done on-chain by the router (unless it's
    // possible to specify a token recipient other than the taker
    // natively - only Wyvern V2.3 supports this).

    if (kind === "foundation") {
      order = order as Sdk.Foundation.Order;

      const exchange = new Sdk.Foundation.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(this.contract.address, order),
        exchangeKind: ExchangeKind.FOUNDATION,
        maker: order.params.maker,
        isEscrowed: true,
      };
    } else if (kind === "looks-rare") {
      order = order as Sdk.LooksRare.Order;

      const matchParams = order.buildMatching(this.contract.address, {
        tokenId,
      });

      const exchange = new Sdk.LooksRare.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(this.contract.address, order, matchParams),
        exchangeKind: ExchangeKind.LOOKS_RARE,
        maker: order.params.signer,
      };
    } else if (kind === "opendao") {
      order = order as Sdk.OpenDao.Order;

      const matchParams = order.buildMatching();

      const exchange = new Sdk.OpenDao.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(this.contract.address, order, matchParams),
        exchangeKind: ExchangeKind.ZEROEX_V4,
        maker: order.params.maker,
      };
    } else if (kind === "x2y2") {
      order = order as Sdk.X2Y2.Order;

      // X2Y2 requires an API key to fill
      const exchange = new Sdk.X2Y2.Exchange(
        this.chainId,
        // TODO: The SDK should not rely on environment variables
        String(process.env.X2Y2_API_KEY)
      );
      return {
        tx: await exchange.fillOrderTx(this.contract.address, order),
        exchangeKind: ExchangeKind.X2Y2,
        maker: order.params.maker,
      };
    } else if (kind === "zeroex-v4") {
      order = order as Sdk.ZeroExV4.Order;

      // Support passing an amount for partially fillable erc1155 orders
      const matchParams = order.buildMatching({ amount });

      const exchange = new Sdk.ZeroExV4.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(this.contract.address, order, matchParams),
        exchangeKind: ExchangeKind.ZEROEX_V4,
        maker: order.params.maker,
      };
    } else if (kind === "seaport") {
      order = order as Sdk.Seaport.Order;

      // Support passing an amount for partially fillable orders
      const matchParams = order.buildMatching({ amount });

      const exchange = new Sdk.Seaport.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(this.contract.address, order, matchParams, {
          recipient: taker,
        }),
        exchangeKind: ExchangeKind.SEAPORT,
        maker: order.params.offerer,
      };
    }

    throw new Error("Unreachable");
  }

  private async generateNativeBidFillTx(
    { kind, order, tokenId, extraArgs }: BidDetails,
    taker: string
  ): Promise<{ tx: TxData; exchangeKind: ExchangeKind }> {
    // When filling through the router, in all below cases we set
    // the router contract as the taker since forwarding received
    // tokens to the actual taker of the order will be taken care
    // of on-chain by the router.

    const filler = this.contract.address;

    if (kind === "looks-rare") {
      order = order as Sdk.LooksRare.Order;

      const matchParams = order.buildMatching(filler, {
        tokenId,
        ...(extraArgs || {}),
      });

      const exchange = new Sdk.LooksRare.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(filler, order, matchParams),
        exchangeKind: ExchangeKind.LOOKS_RARE,
      };
    } else if (kind === "opendao") {
      order = order as Sdk.OpenDao.Order;

      const matchParams = order.buildMatching({
        tokenId,
        amount: 1,
        // Do not unwrap in order to be compatible with the router
        unwrapNativeToken: false,
      });

      const exchange = new Sdk.OpenDao.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(filler, order, matchParams, {
          // Do not use the `onReceived` hook filling to be compatible with the router
          noDirectTransfer: true,
        }),
        exchangeKind: ExchangeKind.ZEROEX_V4,
      };
    } else if (kind === "zeroex-v4") {
      order = order as Sdk.ZeroExV4.Order;

      const matchParams = order.buildMatching({
        tokenId,
        amount: 1,
        // Do not unwrap in order to be compatible with the router
        unwrapNativeToken: false,
      });

      const exchange = new Sdk.ZeroExV4.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(filler, order, matchParams, {
          // Do not use the `onReceived` hook filling to be compatible with the router
          noDirectTransfer: true,
        }),
        exchangeKind: ExchangeKind.ZEROEX_V4,
      };
    } else if (kind === "seaport") {
      order = order as Sdk.Seaport.Order;

      const matchParams = order.buildMatching({
        tokenId,
        ...(extraArgs || {}),
        amount: 1,
      });

      const exchange = new Sdk.Seaport.Exchange(this.chainId);
      return {
        tx: exchange.fillOrderTx(
          filler,
          order,
          matchParams,
          // Force using `fulfillAdvancedOrder` to pass router selector whitelist
          {
            recipient: filler,
          }
        ),
        exchangeKind: ExchangeKind.SEAPORT,
      };
    } else if (kind === "x2y2") {
      order = order as Sdk.X2Y2.Order;

      const exchange = new Sdk.X2Y2.Exchange(
        this.chainId,
        // TODO: The SDK should not rely on environment variables
        String(process.env.X2Y2_API_KEY)
      );
      return {
        tx: await exchange.fillOrderTx(taker, order, { tokenId }),
        exchangeKind: ExchangeKind.X2Y2,
      };
    }

    throw new Error("Unreachable");
  }
}
