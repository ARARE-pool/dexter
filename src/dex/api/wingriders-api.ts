import { BaseApi } from './base-api';
import { Asset, Token } from '../models/asset';
import { LiquidityPool } from '../models/liquidity-pool';
import { BaseDex } from '../base-dex';
import axios, { AxiosInstance } from 'axios';
import { tokensMatch } from '../../utils';
import { RequestConfig } from '../../types';

export class WingRidersApi extends BaseApi {

    protected readonly api: AxiosInstance;
    protected readonly dex: BaseDex;

    constructor(dex: BaseDex, requestConfig: RequestConfig) {
        super();

        this.dex = dex;
        this.api = axios.create({
            baseURL: requestConfig.shouldUseRequestProxy
                ? 'https://cors-anywhere.herokuapp.com/https://api.mainnet.wingriders.com/graphql'
                : 'https://api.mainnet.wingriders.com/graphql',
        });
    }

    liquidityPools(assetA: Token, assetB?: Token): Promise<LiquidityPool[]> {
        return this.api.post('', {
            operationName: 'LiquidityPoolsWithMarketData',
            query: `
                query LiquidityPoolsWithMarketData($input: PoolsWithMarketdataInput) {
                    poolsWithMarketdata(input: $input) {
                        ...LiquidityPoolFragment
                    }
                }
                fragment LiquidityPoolFragment on PoolWithMarketdata {
                    issuedShareToken {
                        policyId
                        assetName
                        quantity
                    }
                    tokenA {
                        policyId
                        assetName
                        quantity
                    }
                    tokenB {
                        policyId
                        assetName
                        quantity
                    }
                    treasuryA
                    treasuryB
                }
            `,
            variables: {
                input: {
                    sort: true
                },
            },
        }).then((response: any) => {
            return response.data.data.poolsWithMarketdata.map((pool: any) => {
                const tokenA: Token = pool.tokenA.policyId !== ''
                    ? new Asset(pool.tokenA.policyId, pool.tokenA.assetName)
                    : 'lovelace';
                const tokenB: Token = pool.tokenB.policyId !== ''
                    ? new Asset(pool.tokenB.policyId, pool.tokenB.assetName)
                    : 'lovelace';

                // Filtering for supplied assets
                const isWanted: boolean = tokensMatch(tokenA, assetA)
                    || tokensMatch(tokenB, assetA)
                    || (assetB ? tokensMatch(tokenA, assetB) : false)
                    || (assetB ? tokensMatch(tokenB, assetB) : false)

                if (! isWanted) {
                    return undefined;
                }

                let liquidityPool: LiquidityPool = new LiquidityPool(
                    this.dex.name,
                    '', // todo unavailable
                    tokenA,
                    tokenB,
                    BigInt(pool.treasuryA),
                    BigInt(pool.treasuryB),
                );

                liquidityPool.lpToken = new Asset(pool.issuedShareToken.policyId, pool.issuedShareToken.assetName);
                liquidityPool.totalLpTokens = BigInt(pool.issuedShareToken.quantity);
                liquidityPool.poolFeePercent = 0.35;

                return liquidityPool;
            }).filter((pool: LiquidityPool | undefined) => pool !== undefined);
        });
    }

}