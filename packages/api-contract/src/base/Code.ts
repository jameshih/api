// Copyright 2017-2021 @polkadot/api-contract authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type { SubmittableExtrinsic } from '@polkadot/api/submittable/types';
import type { ApiTypes, DecorateMethod } from '@polkadot/api/types';
import type { EventRecord, Hash } from '@polkadot/types/interfaces';
import type { AnyJson, CodecArg, ISubmittableResult } from '@polkadot/types/types';
import type { AbiConstructor, BlueprintOptions } from '../types';
import type { MapConstructorExec } from './types';

import { SubmittableResult } from '@polkadot/api';
import { ApiBase } from '@polkadot/api/base';
import { assert, compactAddLength, isUndefined, isWasm, stringCamelCase, u8aToU8a } from '@polkadot/util';

import { Abi } from '../Abi';
import { applyOnEvent } from '../util';
import { Base } from './Base';
import { Blueprint } from './Blueprint';
import { Contract } from './contract';
import { createBluePrintTx, EMPTY_SALT, encodeSalt } from './util';

export class CodeSubmittableResult<ApiType extends ApiTypes> extends SubmittableResult {
  public readonly blueprint?: Blueprint<ApiType>;
  public readonly contract?: Contract<ApiType>;

  constructor (result: ISubmittableResult, blueprint?: Blueprint<ApiType>, contract?: Contract<ApiType>) {
    super(result);

    this.blueprint = blueprint;
    this.contract = contract;
  }
}

export class Code<ApiType extends ApiTypes> extends Base<ApiType> {
  public readonly code: Uint8Array;

  readonly #tx: MapConstructorExec<ApiType> = {};

  constructor (api: ApiBase<ApiType>, abi: AnyJson | Abi, wasm: Uint8Array | string | Buffer | null | undefined, decorateMethod: DecorateMethod<ApiType>) {
    super(api, abi, decorateMethod);

    this.code = isWasm(this.abi.project.source.wasm)
      ? this.abi.project.source.wasm
      : u8aToU8a(wasm);

    assert(isWasm(this.code), 'No WASM code provided');

    this.abi.constructors.forEach((c): void => {
      const messageName = stringCamelCase(c.identifier);

      if (isUndefined(this.#tx[messageName])) {
        this.#tx[messageName] = createBluePrintTx((o, p) => this.#instantiate(c, o, p));
      }
    });
  }

  /**
   * @description Deploy the code bundle, creating a Blueprint.
   */
  public createBlueprint (): SubmittableExtrinsic<ApiType, CodeSubmittableResult<ApiType>> {
    return this.api.tx.contracts
      .putCode(compactAddLength(this.code))
      .withResultTransform((result: ISubmittableResult) =>
        new CodeSubmittableResult(result, applyOnEvent(result, ['CodeStored'], ([record]: EventRecord[]) =>
          new Blueprint<ApiType>(this.api, this.abi, record.event.data[0] as Hash, this._decorateMethod)
        ))
      );
  }

  public get tx (): MapConstructorExec<ApiType> {
    return this.#tx;
  }

  #instantiate = (constructorOrId: AbiConstructor | string | number, options: BlueprintOptions, params: CodecArg[]): SubmittableExtrinsic<ApiType, CodeSubmittableResult<ApiType>> => {
    return this.api.tx.contracts.instantiateWithCode
      ? this.#instantiateSingle(constructorOrId, options, params)
      : this.#instantiateDual(constructorOrId, options, params);
  }

  #instantiateSingle = (constructorOrId: AbiConstructor | string | number, { gasLimit = 0, salt, value = 0 }: BlueprintOptions, params: CodecArg[]): SubmittableExtrinsic<ApiType, CodeSubmittableResult<ApiType>> => {
    const encodedSalt = encodeSalt(salt);
    const encoded = this.abi.findConstructor(constructorOrId).toU8a(params);

    return this.api.tx.contracts
      .instantiateWithCode(value, gasLimit, compactAddLength(this.code), encoded, encodedSalt)
      .withResultTransform((result: ISubmittableResult) =>
        new CodeSubmittableResult(result, ...(applyOnEvent(result, ['CodeStored', 'Instantiated'], (records: EventRecord[]) =>
          records.reduce(([blueprint, contract], { event }): [Blueprint<ApiType>?, Contract<ApiType>?] =>
            this.api.events.contracts.Instantiated.is(event)
              ? [blueprint, new Contract<ApiType>(this.api, this.abi, event.data[1], this._decorateMethod)]
              : this.api.events.contracts.CodeStored.is(event)
                ? [new Blueprint<ApiType>(this.api, this.abi, event.data[0], this._decorateMethod), contract]
                : [blueprint, contract],
          [] as [Blueprint<ApiType>?, Contract<ApiType>?])
        ) || []))
      );
  }

  #instantiateDual = (constructorOrId: AbiConstructor | string | number, { gasLimit = 0, salt, value = 0 }: BlueprintOptions, params: CodecArg[]): SubmittableExtrinsic<ApiType, CodeSubmittableResult<ApiType>> => {
    const encodedSalt = encodeSalt(salt);
    const withSalt = this.api.tx.contracts.instantiate.meta.args.length === 5;
    const encoded = this.abi.findConstructor(constructorOrId).toU8a(params, withSalt ? EMPTY_SALT : encodedSalt);
    const tx = withSalt
      ? this.api.tx.contracts.instantiate(value, gasLimit, this.codeHash, encoded, encodedSalt)
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore old style with salt included
      : this.api.tx.contracts.instantiate(value, gasLimit, this.codeHash, encoded);

    return tx.withResultTransform((result: ISubmittableResult) =>
      new BlueprintSubmittableResult(result, applyOnEvent(result, ['Instantiated'], ([record]: EventRecord[]) =>
        new Contract<ApiType>(this.api, this.abi, record.event.data[1] as AccountId, this._decorateMethod)
      ))
    );
  }
}
