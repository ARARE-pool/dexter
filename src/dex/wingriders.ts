import { BaseDex } from './base-dex';
import {
    AssetAddress,
    AssetBalance,
    DatumParameters,
    PayToAddress, RequestConfig, SwapFee,
    UTxO
} from '../types';
import { Asset, Token } from './models/asset';
import { LiquidityPool } from './models/liquidity-pool';
import { BaseDataProvider } from '../providers/data/base-data-provider';
import { correspondingReserves } from '../utils';
import { AddressType, DatumParameterKey } from '../constants';
import { DefinitionBuilder } from '../definition-builder';
import order from './definitions/wingriders/order';
import { BaseApi } from './api/base-api';
import { WingRidersApi } from './api/wingriders-api';

/**
 * WingRiders constants.
 */
const MIN_POOL_ADA: bigint = 3_000_000n;
const MAX_INT: bigint = 9_223_372_036_854_775_807n;

export class WingRiders extends BaseDex {

    public readonly name: string = 'WingRiders';
    public readonly api: BaseApi;

    public readonly orderAddress: string = 'addr1wxr2a8htmzuhj39y2gq7ftkpxv98y2g67tg8zezthgq4jkg0a4ul4';
    public readonly poolValidityAsset: string = '026a18d04a0c642759bb3d83b12e3344894e5c1c7b2aeb1a2113a5704c';

    private _assetAddresses: AssetAddress[] = [];

    constructor(requestConfig: RequestConfig = {}) {
        super();

        this.api = new WingRidersApi(this, requestConfig);
    }

    async liquidityPools(provider: BaseDataProvider, assetA: Token, assetB?: Token): Promise<LiquidityPool[]> {
        const validityAsset: Asset = Asset.fromId(this.poolValidityAsset);
        const assetAddresses: AssetAddress[] = this._assetAddresses.length > 0
            ? this._assetAddresses
            : await provider.assetAddresses(validityAsset);

        const addressPromises: Promise<LiquidityPool[]>[] = assetAddresses.map(async (assetAddress: AssetAddress) => {
            const utxos: UTxO[] = await provider.utxos(assetAddress.address, validityAsset);

            const liquidityPoolPromises: Promise<LiquidityPool | undefined>[] = utxos.map(async (utxo: UTxO) => {
                return this.liquidityPoolFromUtxo(utxo, assetA, assetB);
            });

            return await Promise.all(liquidityPoolPromises)
                .then((liquidityPools: (LiquidityPool | undefined)[]) => {
                    return liquidityPools.filter((liquidityPool?: LiquidityPool) => {
                        return liquidityPool !== undefined;
                    }) as LiquidityPool[]
                });
        });

        return Promise.all(addressPromises)
            .then((liquidityPools: (Awaited<LiquidityPool[]>)[]) => liquidityPools.flat());
    }

    liquidityPoolFromUtxo(utxo: UTxO, assetA: Token, assetB?: Token): LiquidityPool | undefined {
        if (! utxo.datumHash) {
            return undefined;
        }

        const validityAsset: Asset = Asset.fromId(this.poolValidityAsset);
        const assetAId: string = assetA === 'lovelace' ? 'lovelace' : assetA.id();
        const assetBId: string = assetB ? (assetB === 'lovelace' ? 'lovelace' : assetB.id()) : '';

        const relevantAssets: AssetBalance[] = utxo.assetBalances.filter((assetBalance: AssetBalance) => {
            const assetBalanceId: string = assetBalance.asset === 'lovelace' ? 'lovelace' : assetBalance.asset.id();

            return ! assetBalanceId.startsWith(validityAsset.policyId);
        });

        // Irrelevant UTxO
        if (relevantAssets.length < 2) {
            return undefined;
        }

        // Could be ADA/X or X/X pool
        const assetAIndex: number = relevantAssets.length === 2 ? 0 : 1;
        const assetBIndex: number = relevantAssets.length === 2 ? 1 : 2;

        const relevantAssetAId: string = relevantAssets[assetAIndex].asset === 'lovelace'
            ? 'lovelace'
            : (relevantAssets[assetAIndex].asset as Asset).id()
        const relevantAssetBId: string = relevantAssets[assetBIndex].asset === 'lovelace'
            ? 'lovelace'
            : (relevantAssets[assetBIndex].asset as Asset).id()

        // Only grab requested pools
        const matchesFilter: boolean = (relevantAssetAId === assetAId && relevantAssetBId === assetBId)
            || (relevantAssetAId === assetBId && relevantAssetBId === assetAId)
            || (relevantAssetAId === assetAId && ! assetBId)
            || (relevantAssetBId === assetAId && ! assetBId);

        if (! matchesFilter) {
            return undefined;
        }

        const assetAQuantity: bigint = relevantAssets[assetAIndex].quantity;
        const assetBQuantity: bigint = relevantAssets[assetBIndex].quantity;
        const liquidityPool: LiquidityPool = new LiquidityPool(
            this.name,
            utxo.address,
            relevantAssets[assetAIndex].asset,
            relevantAssets[assetBIndex].asset,
            relevantAssets[assetAIndex].asset === 'lovelace'
                ? (assetAQuantity - MIN_POOL_ADA < 1_000_000)
                    ? assetAQuantity - MIN_POOL_ADA
                    : assetAQuantity
                : assetAQuantity,
            relevantAssets[assetBIndex].asset === 'lovelace'
                ? (assetBQuantity - MIN_POOL_ADA < 1_000_000)
                    ? assetBQuantity - MIN_POOL_ADA
                    : assetBQuantity
                : assetBQuantity,
        );

        const lpTokenBalance: AssetBalance | undefined = utxo.assetBalances.find((assetBalance) => {
            return assetBalance.asset !== 'lovelace'
                && assetBalance.asset.policyId === validityAsset.policyId
                && assetBalance.asset.assetNameHex !== validityAsset.assetNameHex;
        });

        if (lpTokenBalance) {
            liquidityPool.lpToken = lpTokenBalance.asset as Asset;
            liquidityPool.totalLpTokens = MAX_INT - lpTokenBalance.quantity;
        }
        liquidityPool.poolFeePercent = 0.35;

        return liquidityPool;
    }

    estimatedReceive(liquidityPool: LiquidityPool, swapInToken: Token, swapInAmount: bigint): bigint {
        const [reserveIn, reserveOut]: bigint[] = correspondingReserves(liquidityPool, swapInToken);

        const swapFee: bigint = ((swapInAmount * BigInt(liquidityPool.poolFeePercent * 100)) + BigInt(10000) - 1n) / 10000n;

        return reserveOut - (reserveIn * reserveOut - 1n) / (reserveIn + swapInAmount - swapFee) - 1n;
    }

    priceImpactPercent(liquidityPool: LiquidityPool, swapInToken: Token, swapInAmount: bigint): number {
        const estimatedReceive: bigint = this.estimatedReceive(liquidityPool, swapInToken, swapInAmount);
        const swapPrice: number = Number(swapInAmount) / Number(estimatedReceive);

        return Math.abs(swapPrice - liquidityPool.price)
            / ((swapPrice + liquidityPool.price) / 2)
            * 100;
    }

    public async buildSwapOrder(swapParameters: DatumParameters): Promise<PayToAddress[]> {
        const agentFee: SwapFee | undefined = this.swapOrderFees().find((fee: SwapFee) => fee.id === 'agentFee');
        const oil: SwapFee | undefined = this.swapOrderFees().find((fee: SwapFee) => fee.id === 'oil');

        if (! agentFee || ! oil) {
            return Promise.reject('Parameters for datum are not set.');
        }

        const swapInToken: string = (swapParameters.SwapInTokenPolicyId as string) + (swapParameters.SwapInTokenAssetName as string);
        const swapOutToken: string = (swapParameters.SwapOutTokenPolicyId as string) + (swapParameters.SwapOutTokenAssetName as string);
        const swapDirection: number = [swapInToken, swapOutToken].sort((a: string, b: string) => {
            return a.localeCompare(b);
        })[0] === swapInToken ? 0 : 1;

        swapParameters = {
            ...swapParameters,
            [DatumParameterKey.Action]: swapDirection,
            [DatumParameterKey.Expiration]: new Date().getTime() + (60 * 60 * 6 * 1000),
            [DatumParameterKey.PoolAssetAPolicyId]: swapDirection === 0
                ? swapParameters.SwapInTokenPolicyId
                : swapParameters.SwapOutTokenPolicyId,
            [DatumParameterKey.PoolAssetAAssetName]: swapDirection === 0
                ? swapParameters.SwapInTokenAssetName
                : swapParameters.SwapOutTokenAssetName,
            [DatumParameterKey.PoolAssetBPolicyId]: swapDirection === 0
                ? swapParameters.SwapOutTokenPolicyId
                : swapParameters.SwapInTokenPolicyId,
            [DatumParameterKey.PoolAssetBAssetName]: swapDirection === 0
                ? swapParameters.SwapOutTokenAssetName
                : swapParameters.SwapInTokenAssetName,
        };

        const datumBuilder: DefinitionBuilder = new DefinitionBuilder();
        await datumBuilder.loadDefinition(order)
            .then((builder: DefinitionBuilder) => {
                builder.pushParameters(swapParameters);
            });

        return [
            this.buildSwapOrderPayment(
                swapParameters,
                {
                    address: this.orderAddress,
                    addressType: AddressType.Contract,
                    assetBalances: [
                        {
                            asset: 'lovelace',
                            quantity: agentFee.value + oil.value,
                        },
                    ],
                    datum: datumBuilder.getCbor(),
                }
            )
        ];
    }

    public async buildCancelSwapOrder(txOutputs: UTxO[], returnAddress: string): Promise<PayToAddress[]> {
        const relevantUtxo: UTxO | undefined = txOutputs.find((utxo: UTxO) => {
            return utxo.address === this.orderAddress;
        });

        if (! relevantUtxo) {
            return Promise.reject('Unable to find relevant UTxO for cancelling the swap order.');
        }

        return [
            {
                address: returnAddress,
                addressType: AddressType.Base,
                assetBalances: relevantUtxo.assetBalances,
                spendUtxos: [relevantUtxo],
            }
        ];
    }

    public swapOrderFees(): SwapFee[] {
        return [
            {
                id: 'agentFee',
                title: 'Agent Fee',
                description: 'WingRiders DEX employs decentralized Agents to ensure equal access, strict fulfillment ordering and protection to every party involved in exchange for a small fee.',
                value: 2_000000n,
                isReturned: false,
            },
            {
                id: 'oil',
                title: 'Oil',
                description: 'A small amount of ADA has to be bundled with all token transfers on the Cardano Blockchain. We call this "Oil ADA" and it is always returned to the owner when the request gets fulfilled. If the request expires and the funds are reclaimed, the Oil ADA is returned as well.',
                value: 2_000000n,
                isReturned: true,
            },
        ];
    }

}