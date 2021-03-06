/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as firestore from 'firestore';

import { DatabaseId } from '../core/database_info';
import { Timestamp } from '../core/timestamp';
import { DocumentKey } from '../model/document_key';
import { FieldValue, ObjectValue } from '../model/field_value';
import {
  ArrayValue,
  BlobValue,
  BooleanValue,
  DoubleValue,
  GeoPointValue,
  IntegerValue,
  NullValue,
  RefValue,
  StringValue,
  TimestampValue
} from '../model/field_value';
import {
  FieldMask,
  FieldTransform,
  Mutation,
  PatchMutation,
  Precondition,
  ServerTimestampTransform,
  SetMutation,
  TransformMutation
} from '../model/mutation';
import { FieldPath } from '../model/path';
import { assert, fail } from '../util/assert';
import { Code, FirestoreError } from '../util/error';
import { isPlainObject, valueDescription } from '../util/input_validation';
import { AnyJs, primitiveComparator } from '../util/misc';
import * as objUtils from '../util/obj';
import { Dict } from '../util/obj';
import { SortedMap } from '../util/sorted_map';
import * as typeUtils from '../util/types';

import { Blob } from './blob';
import {
  FieldPath as ExternalFieldPath,
  fromDotSeparatedString
} from './field_path';
import {
  DeleteFieldValueImpl,
  FieldValueImpl,
  ServerTimestampFieldValueImpl
} from './field_value';
import { GeoPoint } from './geo_point';

const RESERVED_FIELD_REGEX = /^__.*__$/;

/** The result of parsing document data (e.g. for a setData call). */
export class ParsedSetData {
  constructor(
    readonly data: ObjectValue,
    readonly fieldMask: FieldMask | null,
    readonly fieldTransforms: FieldTransform[]
  ) {}

  toMutations(key: DocumentKey, precondition: Precondition): Mutation[] {
    const mutations = [] as Mutation[];
    if (this.fieldMask !== null) {
      mutations.push(
        new PatchMutation(key, this.data, this.fieldMask, precondition)
      );
    } else {
      mutations.push(new SetMutation(key, this.data, precondition));
    }
    if (this.fieldTransforms.length > 0) {
      mutations.push(new TransformMutation(key, this.fieldTransforms));
    }
    return mutations;
  }
}

/** The result of parsing "update" data (i.e. for an updateData call). */
export class ParsedUpdateData {
  constructor(
    readonly data: ObjectValue,
    readonly fieldMask: FieldMask,
    readonly fieldTransforms: FieldTransform[]
  ) {}

  toMutations(key: DocumentKey, precondition: Precondition): Mutation[] {
    const mutations = [
      new PatchMutation(key, this.data, this.fieldMask, precondition)
    ] as Mutation[];
    if (this.fieldTransforms.length > 0) {
      mutations.push(new TransformMutation(key, this.fieldTransforms));
    }
    return mutations;
  }
}

/*
 * Represents what type of API method provided the data being parsed; useful
 * for determining which error conditions apply during parsing and providing
 * better error messages.
 */
enum UserDataSource {
  Set,
  Update,
  QueryValue // from a where clause or cursor bound
}

/** A "context" object passed around while parsing user data. */
class ParseContext {
  readonly fieldTransforms: FieldTransform[];
  readonly fieldMask: FieldPath[];
  /**
   * Initializes a ParseContext with the given source and path.
   *
   * @param dataSource Indicates what kind of API method this data came from.
   * @param path A path within the object being parsed. This could be an empty
   * path (in which case the context represents the root of the data being
   * parsed), or a nonempty path (indicating the context represents a nested
   * location within the data).
   *
   * TODO(b/34871131): We don't support array paths right now, so path can be
   * null to indicate the context represents any location within an array (in
   * which case certain features will not work and errors will be somewhat
   * compromised).
   * @param fieldTransforms A mutable list of field transforms encountered while
   * parsing the data.
   * @param fieldMask A mutable list of field paths encountered while parsing 
   * the data.
   */
  constructor(
    readonly dataSource: UserDataSource,
    readonly methodName: string,
    readonly path: FieldPath | null,
    fieldTransforms?: FieldTransform[],
    fieldMask?: FieldPath[]
  ) {
    // Minor hack: If fieldTransforms is undefined, we assume this is an
    // external call and we need to validate the entire path.
    if (fieldTransforms === undefined) {
      this.validatePath();
    }
    this.fieldTransforms = fieldTransforms || [];
    this.fieldMask = fieldMask || [];
  }

  childContext(field: string | FieldPath | number): ParseContext {
    let childPath: FieldPath | null;
    if (typeof field === 'number') {
      // TODO(b/34871131): We don't support array paths right now; so make path
      // null.
      childPath = null;
    } else {
      childPath = this.path == null ? null : this.path.child(field);
    }
    const context = new ParseContext(
      this.dataSource,
      this.methodName,
      childPath,
      this.fieldTransforms,
      this.fieldMask
    );
    if (typeof field === 'string') {
      // We only need to validate the new segment.
      context.validatePathSegment(field);
    } else if (typeof field === 'object' && field instanceof FieldPath) {
      // Validate the whole path.
      context.validatePath();
    }
    return context;
  }

  createError(reason: string): Error {
    const fieldDescription =
      this.path === null || this.path.isEmpty()
        ? ''
        : ` (found in field ${this.path.toString()})`;
    return new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Function ${this.methodName}() called with invalid data. ` +
        reason +
        fieldDescription
    );
  }

  private validatePath() {
    // TODO(b/34871131): Remove null check once we have proper paths for fields
    // within arrays.
    if (this.path === null) {
      return;
    }
    for (let i = 0; i < this.path.length; i++) {
      this.validatePathSegment(this.path.get(i));
    }
  }

  private validatePathSegment(segment: string) {
    if (this.isWrite() && RESERVED_FIELD_REGEX.test(segment)) {
      throw this.createError('Document fields cannot begin and end with __');
    }
  }

  private isWrite(): boolean {
    return (
      this.dataSource === UserDataSource.Set ||
      this.dataSource === UserDataSource.Update
    );
  }
}
/**
 * An interface that allows arbitrary pre-converting of user data. This
 * abstraction allows for, e.g.:
 *  * The public API to convert DocumentReference objects to DocRef objects,
 *    avoiding a circular dependency between user_data_converter.ts and
 *    database.ts
 *  * Tests to convert test-only sentinels (e.g. '<DELETE>') into types
 *    compatible with UserDataConverter.
 *
 * Returns the converted value (can return back the input to act as a no-op).
 *
 * It can also throw an Error which will be wrapped into a friendly message.
 */
export type DataPreConverter = (input: AnyJs) => AnyJs;

/**
 * A placeholder object for DocumentReferences in this file, in order to
 * avoid a circular dependency. See the comments for `DataPreConverter` for
 * the full context.
 */
export class DocumentKeyReference {
  constructor(public databaseId: DatabaseId, public key: DocumentKey) {}
}

/**
 * Helper for parsing raw user input (provided via the API) into internal model
 * classes.
 */
export class UserDataConverter {
  constructor(private preConverter: DataPreConverter) {}

  /** Parse document data (e.g. from a set() call). */
  parseSetData(
    methodName: string,
    input: AnyJs,
    options: firestore.SetOptions
  ): ParsedSetData {
    const context = new ParseContext(
      UserDataSource.Set,
      methodName,
      FieldPath.EMPTY_PATH
    );
    validatePlainObject('Data must be an object, but it was:', context, input);

    const merge = options.merge !== undefined ? options.merge : false;

    let updateData = ObjectValue.EMPTY;

    objUtils.forEach(input as Dict<AnyJs>, (key, value) => {
      const path = new ExternalFieldPath(key)._internalPath;

      const childContext = context.childContext(path);
      value = this.runPreConverter(value, childContext);

      const parsedValue = this.parseData(value, childContext);
      if (parsedValue) {
        updateData = updateData.set(path, parsedValue);
      }
    });

    const fieldMask = merge ? new FieldMask(context.fieldMask) : null;
    return new ParsedSetData(updateData, fieldMask, context.fieldTransforms);
  }

  /** Parse update data (e.g. from an update() call). */
  parseUpdateData(methodName: string, input: AnyJs): ParsedUpdateData {
    const context = new ParseContext(
      UserDataSource.Update,
      methodName,
      FieldPath.EMPTY_PATH
    );
    validatePlainObject('Data must be an object, but it was:', context, input);

    const fieldMaskPaths = [] as FieldPath[];
    let updateData = ObjectValue.EMPTY;
    objUtils.forEach(input as Dict<AnyJs>, (key, value) => {
      const path = fieldPathFromDotSeparatedString(methodName, key);

      const childContext = context.childContext(path);
      value = this.runPreConverter(value, childContext);
      if (value instanceof DeleteFieldValueImpl) {
        // Add it to the field mask, but don't add anything to updateData.
        fieldMaskPaths.push(path);
      } else {
        const parsedValue = this.parseData(value, childContext);
        if (parsedValue != null) {
          fieldMaskPaths.push(path);
          updateData = updateData.set(path, parsedValue);
        }
      }
    });

    const mask = new FieldMask(fieldMaskPaths);
    return new ParsedUpdateData(updateData, mask, context.fieldTransforms);
  }

  /** Parse update data from a list of field/value arguments. */
  parseUpdateVarargs(
    methodName: string,
    field: string | ExternalFieldPath,
    value: AnyJs,
    moreFieldsAndValues: AnyJs[]
  ): ParsedUpdateData {
    const context = new ParseContext(
      UserDataSource.Update,
      methodName,
      FieldPath.EMPTY_PATH
    );
    const keys = [fieldPathFromArgument(methodName, field)];
    const values = [value];

    if (moreFieldsAndValues.length % 2 !== 0) {
      throw new FirestoreError(
        Code.INVALID_ARGUMENT,
        `Function ${methodName}() needs to be called with an even number ` +
          'of arguments that alternate between field names and values.'
      );
    }

    for (let i = 0; i < moreFieldsAndValues.length; i += 2) {
      keys.push(
        fieldPathFromArgument(methodName, moreFieldsAndValues[i] as
          | string
          | ExternalFieldPath)
      );
      values.push(moreFieldsAndValues[i + 1]);
    }

    const fieldMaskPaths = [] as FieldPath[];
    let updateData = ObjectValue.EMPTY;

    for (let i = 0; i < keys.length; ++i) {
      const path = keys[i];
      const childContext = context.childContext(path);
      const value = this.runPreConverter(values[i], childContext);
      if (value instanceof DeleteFieldValueImpl) {
        // Add it to the field mask, but don't add anything to updateData.
        fieldMaskPaths.push(path);
      } else {
        const parsedValue = this.parseData(value, childContext);
        if (parsedValue != null) {
          fieldMaskPaths.push(path);
          updateData = updateData.set(path, parsedValue);
        }
      }
    }

    const mask = new FieldMask(fieldMaskPaths);
    return new ParsedUpdateData(updateData, mask, context.fieldTransforms);
  }

  /**
   * Parse a "query value" (e.g. value in a where filter or a value in a cursor
   * bound).
   */
  parseQueryValue(methodName: string, input: AnyJs): FieldValue {
    const context = new ParseContext(
      UserDataSource.QueryValue,
      methodName,
      FieldPath.EMPTY_PATH
    );
    const parsed = this.parseData(input, context);
    assert(parsed != null, 'Parsed data should not be null.');
    assert(
      context.fieldTransforms.length === 0,
      'Field transforms should have been disallowed.'
    );
    return parsed!;
  }

  /** Sends data through this.preConverter, handling any thrown errors. */
  private runPreConverter(input: AnyJs, context: ParseContext): AnyJs {
    try {
      return this.preConverter(input);
    } catch (e) {
      const message = errorMessage(e);
      throw context.createError(message);
    }
  }

  /**
   * Internal helper for parsing user data.
   *
   * @param input Data to be parsed.
   * @param context A context object representing the current path being parsed,
   * the source of the data being parsed, etc.
   * @return The parsed value, or null if the value was a FieldValue sentinel
   * that should not be included in the resulting parsed data.
   */
  private parseData(input: AnyJs, context: ParseContext): FieldValue | null {
    input = this.runPreConverter(input, context);
    if (input instanceof Array) {
      // TODO(b/34871131): We may need a different way to detect nested arrays
      // once we support array paths (at which point we should include the path
      // containing the array in the error message).
      if (!context.path) {
        throw context.createError('Nested arrays are not supported');
      }
      // We don't support field mask paths more granular than the top-level
      // array.
      context.fieldMask.push(context.path);
      return this.parseArray(input as AnyJs[], context);
    } else if (looksLikeJsonObject(input)) {
      validatePlainObject('Unsupported field value:', context, input);
      return this.parseObject(input as Dict<AnyJs>, context);
    } else {
      // If context.path is null, we are inside an array and we should have
      // already added the root of the array to the field mask.
      if (context.path) {
        context.fieldMask.push(context.path);
      }
      return this.parseScalarValue(input, context);
    }
  }

  private parseArray(array: AnyJs[], context: ParseContext): FieldValue {
    const result = [] as FieldValue[];
    let entryIndex = 0;
    for (const entry of array) {
      let parsedEntry = this.parseData(entry, context.childContext(entryIndex));
      if (parsedEntry == null) {
        // Just include nulls in the array for fields being replaced with a
        // sentinel.
        parsedEntry = NullValue.INSTANCE;
      }
      result.push(parsedEntry);
      entryIndex++;
    }
    return new ArrayValue(result);
  }

  private parseObject(obj: Dict<AnyJs>, context: ParseContext): FieldValue {
    let result = new SortedMap<string, FieldValue>(primitiveComparator);
    objUtils.forEach(obj, (key: string, val: AnyJs) => {
      const parsedValue = this.parseData(val, context.childContext(key));
      if (parsedValue != null) {
        result = result.insert(key, parsedValue);
      }
    });
    return new ObjectValue(result);
  }

  /**
   * Helper to parse a scalar value (i.e. not an Object or Array)
   *
   * @return The parsed value, or null if the value was a FieldValue sentinel
   * that should not be included in the resulting parsed data.
   */
  private parseScalarValue(
    value: AnyJs,
    context: ParseContext
  ): FieldValue | null {
    if (value === null) {
      return NullValue.INSTANCE;
    } else if (typeof value === 'number') {
      if (typeUtils.isSafeInteger(value)) {
        return new IntegerValue(value);
      } else {
        return new DoubleValue(value);
      }
    } else if (typeof value === 'boolean') {
      return BooleanValue.of(value);
    } else if (typeof value === 'string') {
      return new StringValue(value);
    } else if (value instanceof Date) {
      return new TimestampValue(Timestamp.fromDate(value));
    } else if (value instanceof GeoPoint) {
      return new GeoPointValue(value);
    } else if (value instanceof Blob) {
      return new BlobValue(value);
    } else if (value instanceof DocumentKeyReference) {
      return new RefValue(value.databaseId, value.key);
    } else if (value instanceof FieldValueImpl) {
      if (value instanceof DeleteFieldValueImpl) {
        // We shouldn't encounter delete sentinels here. Provide a good error.
        if (context.dataSource !== UserDataSource.Update) {
          throw context.createError(
            'FieldValue.delete() can only be used with update()'
          );
        } else {
          assert(
            context.path == null || context.path.length > 0,
            'FieldValue.delete() at the top level should have already' +
              ' been handled.'
          );
          throw context.createError(
            'FieldValue.delete() can only appear at the top level ' +
              'of your update data'
          );
        }
      } else if (value instanceof ServerTimestampFieldValueImpl) {
        if (
          context.dataSource !== UserDataSource.Set &&
          context.dataSource !== UserDataSource.Update
        ) {
          throw context.createError(
            'FieldValue.serverTimestamp() can only be used with set()' +
              ' and update()'
          );
        }
        if (context.path === null) {
          throw context.createError(
            'FieldValue.serverTimestamp() is not currently' +
              ' supported inside arrays'
          );
        }
        context.fieldTransforms.push(
          new FieldTransform(context.path, ServerTimestampTransform.instance)
        );

        // Return null so this value is omitted from the parsed result.
        return null;
      } else {
        return fail('Unknown FieldValue type: ' + value);
      }
    } else {
      throw context.createError(
        `Unsupported field value: ${valueDescription(value)}`
      );
    }
  }
}

/**
 * Checks whether an object looks like a JSON object that should be converted
 * into a struct. Normal class/prototype instances are considered to look like
 * JSON objects since they should be converted to a struct value. Arrays, Dates,
 * GeoPoints, etc. are not considered to look like JSON objects since they map
 * to specific FieldValue types other than ObjectValue.
 */
function looksLikeJsonObject(input: AnyJs): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !(input instanceof Array) &&
    !(input instanceof Date) &&
    !(input instanceof GeoPoint) &&
    !(input instanceof Blob) &&
    !(input instanceof DocumentKeyReference) &&
    !(input instanceof FieldValueImpl)
  );
}

function validatePlainObject(
  message: string,
  context: ParseContext,
  input: AnyJs
) {
  if (!looksLikeJsonObject(input) || !isPlainObject(input)) {
    const description = valueDescription(input);
    if (description === 'an object') {
      // Massage the error if it was an object.
      throw context.createError(message + ' a custom object');
    } else {
      throw context.createError(message + ' ' + description);
    }
  }
}

/**
 * Helper that calls fromDotSeparatedString() but wraps any error thrown.
 */
export function fieldPathFromArgument(
  methodName: string,
  path: string | ExternalFieldPath
): FieldPath {
  if (path instanceof ExternalFieldPath) {
    return path._internalPath;
  } else if (typeof path === 'string') {
    return fieldPathFromDotSeparatedString(methodName, path);
  } else {
    const message = 'Field path arguments must be of type string or FieldPath.';
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Function ${methodName}() called with invalid data. ${message}`
    );
  }
}

/**
 * Wraps fromDotSeparatedString with an error message about the method that
 * was thrown.
 * @param methodName The publicly visible method name
 * @param path The dot-separated string form of a field path which will be split
 * on dots.
 */
function fieldPathFromDotSeparatedString(
  methodName: string,
  path: string
): FieldPath {
  try {
    return fromDotSeparatedString(path)._internalPath;
  } catch (e) {
    const message = errorMessage(e);
    throw new FirestoreError(
      Code.INVALID_ARGUMENT,
      `Function ${methodName}() called with invalid data. ${message}`
    );
  }
}

/**
 * Extracts the message from a caught exception, which should be an Error object
 * though JS doesn't guarantee that.
 */
function errorMessage(error: Error | object): string {
  return error instanceof Error ? error.message : error.toString();
}
