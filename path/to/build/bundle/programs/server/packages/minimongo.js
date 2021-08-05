(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var ECMAScript = Package.ecmascript.ECMAScript;
var EJSON = Package.ejson.EJSON;
var GeoJSON = Package['geojson-utils'].GeoJSON;
var IdMap = Package['id-map'].IdMap;
var MongoID = Package['mongo-id'].MongoID;
var OrderedDict = Package['ordered-dict'].OrderedDict;
var Random = Package.random.Random;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var Decimal = Package['mongo-decimal'].Decimal;
var meteorInstall = Package.modules.meteorInstall;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var operand, selectorValue, MinimongoTest, MinimongoError, selector, doc, callback, options, oldResults, a, b, LocalCollection, Minimongo;

var require = meteorInstall({"node_modules":{"meteor":{"minimongo":{"minimongo_server.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/minimongo_server.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.link("./minimongo_common.js");
let hasOwn, isNumericKey, isOperatorObject, pathsToTree, projectionDetails;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  },

  isNumericKey(v) {
    isNumericKey = v;
  },

  isOperatorObject(v) {
    isOperatorObject = v;
  },

  pathsToTree(v) {
    pathsToTree = v;
  },

  projectionDetails(v) {
    projectionDetails = v;
  }

}, 0);

Minimongo._pathsElidingNumericKeys = paths => paths.map(path => path.split('.').filter(part => !isNumericKey(part)).join('.')); // Returns true if the modifier applied to some document may change the result
// of matching the document by selector
// The modifier is always in a form of Object:
//  - $set
//    - 'a.b.22.z': value
//    - 'foo.bar': 42
//  - $unset
//    - 'abc.d': 1


Minimongo.Matcher.prototype.affectedByModifier = function (modifier) {
  // safe check for $set/$unset being objects
  modifier = Object.assign({
    $set: {},
    $unset: {}
  }, modifier);

  const meaningfulPaths = this._getPaths();

  const modifiedPaths = [].concat(Object.keys(modifier.$set), Object.keys(modifier.$unset));
  return modifiedPaths.some(path => {
    const mod = path.split('.');
    return meaningfulPaths.some(meaningfulPath => {
      const sel = meaningfulPath.split('.');
      let i = 0,
          j = 0;

      while (i < sel.length && j < mod.length) {
        if (isNumericKey(sel[i]) && isNumericKey(mod[j])) {
          // foo.4.bar selector affected by foo.4 modifier
          // foo.3.bar selector unaffected by foo.4 modifier
          if (sel[i] === mod[j]) {
            i++;
            j++;
          } else {
            return false;
          }
        } else if (isNumericKey(sel[i])) {
          // foo.4.bar selector unaffected by foo.bar modifier
          return false;
        } else if (isNumericKey(mod[j])) {
          j++;
        } else if (sel[i] === mod[j]) {
          i++;
          j++;
        } else {
          return false;
        }
      } // One is a prefix of another, taking numeric fields into account


      return true;
    });
  });
}; // @param modifier - Object: MongoDB-styled modifier with `$set`s and `$unsets`
//                           only. (assumed to come from oplog)
// @returns - Boolean: if after applying the modifier, selector can start
//                     accepting the modified value.
// NOTE: assumes that document affected by modifier didn't match this Matcher
// before, so if modifier can't convince selector in a positive change it would
// stay 'false'.
// Currently doesn't support $-operators and numeric indices precisely.


Minimongo.Matcher.prototype.canBecomeTrueByModifier = function (modifier) {
  if (!this.affectedByModifier(modifier)) {
    return false;
  }

  if (!this.isSimple()) {
    return true;
  }

  modifier = Object.assign({
    $set: {},
    $unset: {}
  }, modifier);
  const modifierPaths = [].concat(Object.keys(modifier.$set), Object.keys(modifier.$unset));

  if (this._getPaths().some(pathHasNumericKeys) || modifierPaths.some(pathHasNumericKeys)) {
    return true;
  } // check if there is a $set or $unset that indicates something is an
  // object rather than a scalar in the actual object where we saw $-operator
  // NOTE: it is correct since we allow only scalars in $-operators
  // Example: for selector {'a.b': {$gt: 5}} the modifier {'a.b.c':7} would
  // definitely set the result to false as 'a.b' appears to be an object.


  const expectedScalarIsObject = Object.keys(this._selector).some(path => {
    if (!isOperatorObject(this._selector[path])) {
      return false;
    }

    return modifierPaths.some(modifierPath => modifierPath.startsWith("".concat(path, ".")));
  });

  if (expectedScalarIsObject) {
    return false;
  } // See if we can apply the modifier on the ideally matching object. If it
  // still matches the selector, then the modifier could have turned the real
  // object in the database into something matching.


  const matchingDocument = EJSON.clone(this.matchingDocument()); // The selector is too complex, anything can happen.

  if (matchingDocument === null) {
    return true;
  }

  try {
    LocalCollection._modify(matchingDocument, modifier);
  } catch (error) {
    // Couldn't set a property on a field which is a scalar or null in the
    // selector.
    // Example:
    // real document: { 'a.b': 3 }
    // selector: { 'a': 12 }
    // converted selector (ideal document): { 'a': 12 }
    // modifier: { $set: { 'a.b': 4 } }
    // We don't know what real document was like but from the error raised by
    // $set on a scalar field we can reason that the structure of real document
    // is completely different.
    if (error.name === 'MinimongoError' && error.setPropertyError) {
      return false;
    }

    throw error;
  }

  return this.documentMatches(matchingDocument).result;
}; // Knows how to combine a mongo selector and a fields projection to a new fields
// projection taking into account active fields from the passed selector.
// @returns Object - projection object (same as fields option of mongo cursor)


Minimongo.Matcher.prototype.combineIntoProjection = function (projection) {
  const selectorPaths = Minimongo._pathsElidingNumericKeys(this._getPaths()); // Special case for $where operator in the selector - projection should depend
  // on all fields of the document. getSelectorPaths returns a list of paths
  // selector depends on. If one of the paths is '' (empty string) representing
  // the root or the whole document, complete projection should be returned.


  if (selectorPaths.includes('')) {
    return {};
  }

  return combineImportantPathsIntoProjection(selectorPaths, projection);
}; // Returns an object that would match the selector if possible or null if the
// selector is too complex for us to analyze
// { 'a.b': { ans: 42 }, 'foo.bar': null, 'foo.baz': "something" }
// => { a: { b: { ans: 42 } }, foo: { bar: null, baz: "something" } }


Minimongo.Matcher.prototype.matchingDocument = function () {
  // check if it was computed before
  if (this._matchingDocument !== undefined) {
    return this._matchingDocument;
  } // If the analysis of this selector is too hard for our implementation
  // fallback to "YES"


  let fallback = false;
  this._matchingDocument = pathsToTree(this._getPaths(), path => {
    const valueSelector = this._selector[path];

    if (isOperatorObject(valueSelector)) {
      // if there is a strict equality, there is a good
      // chance we can use one of those as "matching"
      // dummy value
      if (valueSelector.$eq) {
        return valueSelector.$eq;
      }

      if (valueSelector.$in) {
        const matcher = new Minimongo.Matcher({
          placeholder: valueSelector
        }); // Return anything from $in that matches the whole selector for this
        // path. If nothing matches, returns `undefined` as nothing can make
        // this selector into `true`.

        return valueSelector.$in.find(placeholder => matcher.documentMatches({
          placeholder
        }).result);
      }

      if (onlyContainsKeys(valueSelector, ['$gt', '$gte', '$lt', '$lte'])) {
        let lowerBound = -Infinity;
        let upperBound = Infinity;
        ['$lte', '$lt'].forEach(op => {
          if (hasOwn.call(valueSelector, op) && valueSelector[op] < upperBound) {
            upperBound = valueSelector[op];
          }
        });
        ['$gte', '$gt'].forEach(op => {
          if (hasOwn.call(valueSelector, op) && valueSelector[op] > lowerBound) {
            lowerBound = valueSelector[op];
          }
        });
        const middle = (lowerBound + upperBound) / 2;
        const matcher = new Minimongo.Matcher({
          placeholder: valueSelector
        });

        if (!matcher.documentMatches({
          placeholder: middle
        }).result && (middle === lowerBound || middle === upperBound)) {
          fallback = true;
        }

        return middle;
      }

      if (onlyContainsKeys(valueSelector, ['$nin', '$ne'])) {
        // Since this._isSimple makes sure $nin and $ne are not combined with
        // objects or arrays, we can confidently return an empty object as it
        // never matches any scalar.
        return {};
      }

      fallback = true;
    }

    return this._selector[path];
  }, x => x);

  if (fallback) {
    this._matchingDocument = null;
  }

  return this._matchingDocument;
}; // Minimongo.Sorter gets a similar method, which delegates to a Matcher it made
// for this exact purpose.


Minimongo.Sorter.prototype.affectedByModifier = function (modifier) {
  return this._selectorForAffectedByModifier.affectedByModifier(modifier);
};

Minimongo.Sorter.prototype.combineIntoProjection = function (projection) {
  return combineImportantPathsIntoProjection(Minimongo._pathsElidingNumericKeys(this._getPaths()), projection);
};

function combineImportantPathsIntoProjection(paths, projection) {
  const details = projectionDetails(projection); // merge the paths to include

  const tree = pathsToTree(paths, path => true, (node, path, fullPath) => true, details.tree);
  const mergedProjection = treeToPaths(tree);

  if (details.including) {
    // both selector and projection are pointing on fields to include
    // so we can just return the merged tree
    return mergedProjection;
  } // selector is pointing at fields to include
  // projection is pointing at fields to exclude
  // make sure we don't exclude important paths


  const mergedExclProjection = {};
  Object.keys(mergedProjection).forEach(path => {
    if (!mergedProjection[path]) {
      mergedExclProjection[path] = false;
    }
  });
  return mergedExclProjection;
}

function getPaths(selector) {
  return Object.keys(new Minimongo.Matcher(selector)._paths); // XXX remove it?
  // return Object.keys(selector).map(k => {
  //   // we don't know how to handle $where because it can be anything
  //   if (k === '$where') {
  //     return ''; // matches everything
  //   }
  //   // we branch from $or/$and/$nor operator
  //   if (['$or', '$and', '$nor'].includes(k)) {
  //     return selector[k].map(getPaths);
  //   }
  //   // the value is a literal or some comparison operator
  //   return k;
  // })
  //   .reduce((a, b) => a.concat(b), [])
  //   .filter((a, b, c) => c.indexOf(a) === b);
} // A helper to ensure object has only certain keys


function onlyContainsKeys(obj, keys) {
  return Object.keys(obj).every(k => keys.includes(k));
}

function pathHasNumericKeys(path) {
  return path.split('.').some(isNumericKey);
} // Returns a set of key paths similar to
// { 'foo.bar': 1, 'a.b.c': 1 }


function treeToPaths(tree) {
  let prefix = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : '';
  const result = {};
  Object.keys(tree).forEach(key => {
    const value = tree[key];

    if (value === Object(value)) {
      Object.assign(result, treeToPaths(value, "".concat(prefix + key, ".")));
    } else {
      result[prefix + key] = value;
    }
  });
  return result;
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"common.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/common.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  hasOwn: () => hasOwn,
  ELEMENT_OPERATORS: () => ELEMENT_OPERATORS,
  compileDocumentSelector: () => compileDocumentSelector,
  equalityElementMatcher: () => equalityElementMatcher,
  expandArraysInBranches: () => expandArraysInBranches,
  isIndexable: () => isIndexable,
  isNumericKey: () => isNumericKey,
  isOperatorObject: () => isOperatorObject,
  makeLookupFunction: () => makeLookupFunction,
  nothingMatcher: () => nothingMatcher,
  pathsToTree: () => pathsToTree,
  populateDocumentWithQueryFields: () => populateDocumentWithQueryFields,
  projectionDetails: () => projectionDetails,
  regexpElementMatcher: () => regexpElementMatcher
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }

}, 0);
const hasOwn = Object.prototype.hasOwnProperty;
const ELEMENT_OPERATORS = {
  $lt: makeInequality(cmpValue => cmpValue < 0),
  $gt: makeInequality(cmpValue => cmpValue > 0),
  $lte: makeInequality(cmpValue => cmpValue <= 0),
  $gte: makeInequality(cmpValue => cmpValue >= 0),
  $mod: {
    compileElementSelector(operand) {
      if (!(Array.isArray(operand) && operand.length === 2 && typeof operand[0] === 'number' && typeof operand[1] === 'number')) {
        throw Error('argument to $mod must be an array of two numbers');
      } // XXX could require to be ints or round or something


      const divisor = operand[0];
      const remainder = operand[1];
      return value => typeof value === 'number' && value % divisor === remainder;
    }

  },
  $in: {
    compileElementSelector(operand) {
      if (!Array.isArray(operand)) {
        throw Error('$in needs an array');
      }

      const elementMatchers = operand.map(option => {
        if (option instanceof RegExp) {
          return regexpElementMatcher(option);
        }

        if (isOperatorObject(option)) {
          throw Error('cannot nest $ under $in');
        }

        return equalityElementMatcher(option);
      });
      return value => {
        // Allow {a: {$in: [null]}} to match when 'a' does not exist.
        if (value === undefined) {
          value = null;
        }

        return elementMatchers.some(matcher => matcher(value));
      };
    }

  },
  $size: {
    // {a: [[5, 5]]} must match {a: {$size: 1}} but not {a: {$size: 2}}, so we
    // don't want to consider the element [5,5] in the leaf array [[5,5]] as a
    // possible value.
    dontExpandLeafArrays: true,

    compileElementSelector(operand) {
      if (typeof operand === 'string') {
        // Don't ask me why, but by experimentation, this seems to be what Mongo
        // does.
        operand = 0;
      } else if (typeof operand !== 'number') {
        throw Error('$size needs a number');
      }

      return value => Array.isArray(value) && value.length === operand;
    }

  },
  $type: {
    // {a: [5]} must not match {a: {$type: 4}} (4 means array), but it should
    // match {a: {$type: 1}} (1 means number), and {a: [[5]]} must match {$a:
    // {$type: 4}}. Thus, when we see a leaf array, we *should* expand it but
    // should *not* include it itself.
    dontIncludeLeafArrays: true,

    compileElementSelector(operand) {
      if (typeof operand === 'string') {
        const operandAliasMap = {
          'double': 1,
          'string': 2,
          'object': 3,
          'array': 4,
          'binData': 5,
          'undefined': 6,
          'objectId': 7,
          'bool': 8,
          'date': 9,
          'null': 10,
          'regex': 11,
          'dbPointer': 12,
          'javascript': 13,
          'symbol': 14,
          'javascriptWithScope': 15,
          'int': 16,
          'timestamp': 17,
          'long': 18,
          'decimal': 19,
          'minKey': -1,
          'maxKey': 127
        };

        if (!hasOwn.call(operandAliasMap, operand)) {
          throw Error("unknown string alias for $type: ".concat(operand));
        }

        operand = operandAliasMap[operand];
      } else if (typeof operand === 'number') {
        if (operand === 0 || operand < -1 || operand > 19 && operand !== 127) {
          throw Error("Invalid numerical $type code: ".concat(operand));
        }
      } else {
        throw Error('argument to $type is not a number or a string');
      }

      return value => value !== undefined && LocalCollection._f._type(value) === operand;
    }

  },
  $bitsAllSet: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAllSet');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.every((byte, i) => (bitmask[i] & byte) === byte);
      };
    }

  },
  $bitsAnySet: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAnySet');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.some((byte, i) => (~bitmask[i] & byte) !== byte);
      };
    }

  },
  $bitsAllClear: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAllClear');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.every((byte, i) => !(bitmask[i] & byte));
      };
    }

  },
  $bitsAnyClear: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAnyClear');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.some((byte, i) => (bitmask[i] & byte) !== byte);
      };
    }

  },
  $regex: {
    compileElementSelector(operand, valueSelector) {
      if (!(typeof operand === 'string' || operand instanceof RegExp)) {
        throw Error('$regex has to be a string or RegExp');
      }

      let regexp;

      if (valueSelector.$options !== undefined) {
        // Options passed in $options (even the empty string) always overrides
        // options in the RegExp object itself.
        // Be clear that we only support the JS-supported options, not extended
        // ones (eg, Mongo supports x and s). Ideally we would implement x and s
        // by transforming the regexp, but not today...
        if (/[^gim]/.test(valueSelector.$options)) {
          throw new Error('Only the i, m, and g regexp options are supported');
        }

        const source = operand instanceof RegExp ? operand.source : operand;
        regexp = new RegExp(source, valueSelector.$options);
      } else if (operand instanceof RegExp) {
        regexp = operand;
      } else {
        regexp = new RegExp(operand);
      }

      return regexpElementMatcher(regexp);
    }

  },
  $elemMatch: {
    dontExpandLeafArrays: true,

    compileElementSelector(operand, valueSelector, matcher) {
      if (!LocalCollection._isPlainObject(operand)) {
        throw Error('$elemMatch need an object');
      }

      const isDocMatcher = !isOperatorObject(Object.keys(operand).filter(key => !hasOwn.call(LOGICAL_OPERATORS, key)).reduce((a, b) => Object.assign(a, {
        [b]: operand[b]
      }), {}), true);
      let subMatcher;

      if (isDocMatcher) {
        // This is NOT the same as compileValueSelector(operand), and not just
        // because of the slightly different calling convention.
        // {$elemMatch: {x: 3}} means "an element has a field x:3", not
        // "consists only of a field x:3". Also, regexps and sub-$ are allowed.
        subMatcher = compileDocumentSelector(operand, matcher, {
          inElemMatch: true
        });
      } else {
        subMatcher = compileValueSelector(operand, matcher);
      }

      return value => {
        if (!Array.isArray(value)) {
          return false;
        }

        for (let i = 0; i < value.length; ++i) {
          const arrayElement = value[i];
          let arg;

          if (isDocMatcher) {
            // We can only match {$elemMatch: {b: 3}} against objects.
            // (We can also match against arrays, if there's numeric indices,
            // eg {$elemMatch: {'0.b': 3}} or {$elemMatch: {0: 3}}.)
            if (!isIndexable(arrayElement)) {
              return false;
            }

            arg = arrayElement;
          } else {
            // dontIterate ensures that {a: {$elemMatch: {$gt: 5}}} matches
            // {a: [8]} but not {a: [[8]]}
            arg = [{
              value: arrayElement,
              dontIterate: true
            }];
          } // XXX support $near in $elemMatch by propagating $distance?


          if (subMatcher(arg).result) {
            return i; // specially understood to mean "use as arrayIndices"
          }
        }

        return false;
      };
    }

  }
};
// Operators that appear at the top level of a document selector.
const LOGICAL_OPERATORS = {
  $and(subSelector, matcher, inElemMatch) {
    return andDocumentMatchers(compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch));
  },

  $or(subSelector, matcher, inElemMatch) {
    const matchers = compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch); // Special case: if there is only one matcher, use it directly, *preserving*
    // any arrayIndices it returns.

    if (matchers.length === 1) {
      return matchers[0];
    }

    return doc => {
      const result = matchers.some(fn => fn(doc).result); // $or does NOT set arrayIndices when it has multiple
      // sub-expressions. (Tested against MongoDB.)

      return {
        result
      };
    };
  },

  $nor(subSelector, matcher, inElemMatch) {
    const matchers = compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch);
    return doc => {
      const result = matchers.every(fn => !fn(doc).result); // Never set arrayIndices, because we only match if nothing in particular
      // 'matched' (and because this is consistent with MongoDB).

      return {
        result
      };
    };
  },

  $where(selectorValue, matcher) {
    // Record that *any* path may be used.
    matcher._recordPathUsed('');

    matcher._hasWhere = true;

    if (!(selectorValue instanceof Function)) {
      // XXX MongoDB seems to have more complex logic to decide where or or not
      // to add 'return'; not sure exactly what it is.
      selectorValue = Function('obj', "return ".concat(selectorValue));
    } // We make the document available as both `this` and `obj`.
    // // XXX not sure what we should do if this throws


    return doc => ({
      result: selectorValue.call(doc, doc)
    });
  },

  // This is just used as a comment in the query (in MongoDB, it also ends up in
  // query logs); it has no effect on the actual selection.
  $comment() {
    return () => ({
      result: true
    });
  }

}; // Operators that (unlike LOGICAL_OPERATORS) pertain to individual paths in a
// document, but (unlike ELEMENT_OPERATORS) do not have a simple definition as
// "match each branched value independently and combine with
// convertElementMatcherToBranchedMatcher".

const VALUE_OPERATORS = {
  $eq(operand) {
    return convertElementMatcherToBranchedMatcher(equalityElementMatcher(operand));
  },

  $not(operand, valueSelector, matcher) {
    return invertBranchedMatcher(compileValueSelector(operand, matcher));
  },

  $ne(operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(equalityElementMatcher(operand)));
  },

  $nin(operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(ELEMENT_OPERATORS.$in.compileElementSelector(operand)));
  },

  $exists(operand) {
    const exists = convertElementMatcherToBranchedMatcher(value => value !== undefined);
    return operand ? exists : invertBranchedMatcher(exists);
  },

  // $options just provides options for $regex; its logic is inside $regex
  $options(operand, valueSelector) {
    if (!hasOwn.call(valueSelector, '$regex')) {
      throw Error('$options needs a $regex');
    }

    return everythingMatcher;
  },

  // $maxDistance is basically an argument to $near
  $maxDistance(operand, valueSelector) {
    if (!valueSelector.$near) {
      throw Error('$maxDistance needs a $near');
    }

    return everythingMatcher;
  },

  $all(operand, valueSelector, matcher) {
    if (!Array.isArray(operand)) {
      throw Error('$all requires array');
    } // Not sure why, but this seems to be what MongoDB does.


    if (operand.length === 0) {
      return nothingMatcher;
    }

    const branchedMatchers = operand.map(criterion => {
      // XXX handle $all/$elemMatch combination
      if (isOperatorObject(criterion)) {
        throw Error('no $ expressions in $all');
      } // This is always a regexp or equality selector.


      return compileValueSelector(criterion, matcher);
    }); // andBranchedMatchers does NOT require all selectors to return true on the
    // SAME branch.

    return andBranchedMatchers(branchedMatchers);
  },

  $near(operand, valueSelector, matcher, isRoot) {
    if (!isRoot) {
      throw Error('$near can\'t be inside another $ operator');
    }

    matcher._hasGeoQuery = true; // There are two kinds of geodata in MongoDB: legacy coordinate pairs and
    // GeoJSON. They use different distance metrics, too. GeoJSON queries are
    // marked with a $geometry property, though legacy coordinates can be
    // matched using $geometry.

    let maxDistance, point, distance;

    if (LocalCollection._isPlainObject(operand) && hasOwn.call(operand, '$geometry')) {
      // GeoJSON "2dsphere" mode.
      maxDistance = operand.$maxDistance;
      point = operand.$geometry;

      distance = value => {
        // XXX: for now, we don't calculate the actual distance between, say,
        // polygon and circle. If people care about this use-case it will get
        // a priority.
        if (!value) {
          return null;
        }

        if (!value.type) {
          return GeoJSON.pointDistance(point, {
            type: 'Point',
            coordinates: pointToArray(value)
          });
        }

        if (value.type === 'Point') {
          return GeoJSON.pointDistance(point, value);
        }

        return GeoJSON.geometryWithinRadius(value, point, maxDistance) ? 0 : maxDistance + 1;
      };
    } else {
      maxDistance = valueSelector.$maxDistance;

      if (!isIndexable(operand)) {
        throw Error('$near argument must be coordinate pair or GeoJSON');
      }

      point = pointToArray(operand);

      distance = value => {
        if (!isIndexable(value)) {
          return null;
        }

        return distanceCoordinatePairs(point, value);
      };
    }

    return branchedValues => {
      // There might be multiple points in the document that match the given
      // field. Only one of them needs to be within $maxDistance, but we need to
      // evaluate all of them and use the nearest one for the implicit sort
      // specifier. (That's why we can't just use ELEMENT_OPERATORS here.)
      //
      // Note: This differs from MongoDB's implementation, where a document will
      // actually show up *multiple times* in the result set, with one entry for
      // each within-$maxDistance branching point.
      const result = {
        result: false
      };
      expandArraysInBranches(branchedValues).every(branch => {
        // if operation is an update, don't skip branches, just return the first
        // one (#3599)
        let curDistance;

        if (!matcher._isUpdate) {
          if (!(typeof branch.value === 'object')) {
            return true;
          }

          curDistance = distance(branch.value); // Skip branches that aren't real points or are too far away.

          if (curDistance === null || curDistance > maxDistance) {
            return true;
          } // Skip anything that's a tie.


          if (result.distance !== undefined && result.distance <= curDistance) {
            return true;
          }
        }

        result.result = true;
        result.distance = curDistance;

        if (branch.arrayIndices) {
          result.arrayIndices = branch.arrayIndices;
        } else {
          delete result.arrayIndices;
        }

        return !matcher._isUpdate;
      });
      return result;
    };
  }

}; // NB: We are cheating and using this function to implement 'AND' for both
// 'document matchers' and 'branched matchers'. They both return result objects
// but the argument is different: for the former it's a whole doc, whereas for
// the latter it's an array of 'branched values'.

function andSomeMatchers(subMatchers) {
  if (subMatchers.length === 0) {
    return everythingMatcher;
  }

  if (subMatchers.length === 1) {
    return subMatchers[0];
  }

  return docOrBranches => {
    const match = {};
    match.result = subMatchers.every(fn => {
      const subResult = fn(docOrBranches); // Copy a 'distance' number out of the first sub-matcher that has
      // one. Yes, this means that if there are multiple $near fields in a
      // query, something arbitrary happens; this appears to be consistent with
      // Mongo.

      if (subResult.result && subResult.distance !== undefined && match.distance === undefined) {
        match.distance = subResult.distance;
      } // Similarly, propagate arrayIndices from sub-matchers... but to match
      // MongoDB behavior, this time the *last* sub-matcher with arrayIndices
      // wins.


      if (subResult.result && subResult.arrayIndices) {
        match.arrayIndices = subResult.arrayIndices;
      }

      return subResult.result;
    }); // If we didn't actually match, forget any extra metadata we came up with.

    if (!match.result) {
      delete match.distance;
      delete match.arrayIndices;
    }

    return match;
  };
}

const andDocumentMatchers = andSomeMatchers;
const andBranchedMatchers = andSomeMatchers;

function compileArrayOfDocumentSelectors(selectors, matcher, inElemMatch) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw Error('$and/$or/$nor must be nonempty array');
  }

  return selectors.map(subSelector => {
    if (!LocalCollection._isPlainObject(subSelector)) {
      throw Error('$or/$and/$nor entries need to be full objects');
    }

    return compileDocumentSelector(subSelector, matcher, {
      inElemMatch
    });
  });
} // Takes in a selector that could match a full document (eg, the original
// selector). Returns a function mapping document->result object.
//
// matcher is the Matcher object we are compiling.
//
// If this is the root document selector (ie, not wrapped in $and or the like),
// then isRoot is true. (This is used by $near.)


function compileDocumentSelector(docSelector, matcher) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  const docMatchers = Object.keys(docSelector).map(key => {
    const subSelector = docSelector[key];

    if (key.substr(0, 1) === '$') {
      // Outer operators are either logical operators (they recurse back into
      // this function), or $where.
      if (!hasOwn.call(LOGICAL_OPERATORS, key)) {
        throw new Error("Unrecognized logical operator: ".concat(key));
      }

      matcher._isSimple = false;
      return LOGICAL_OPERATORS[key](subSelector, matcher, options.inElemMatch);
    } // Record this path, but only if we aren't in an elemMatcher, since in an
    // elemMatch this is a path inside an object in an array, not in the doc
    // root.


    if (!options.inElemMatch) {
      matcher._recordPathUsed(key);
    } // Don't add a matcher if subSelector is a function -- this is to match
    // the behavior of Meteor on the server (inherited from the node mongodb
    // driver), which is to ignore any part of a selector which is a function.


    if (typeof subSelector === 'function') {
      return undefined;
    }

    const lookUpByIndex = makeLookupFunction(key);
    const valueMatcher = compileValueSelector(subSelector, matcher, options.isRoot);
    return doc => valueMatcher(lookUpByIndex(doc));
  }).filter(Boolean);
  return andDocumentMatchers(docMatchers);
}

// Takes in a selector that could match a key-indexed value in a document; eg,
// {$gt: 5, $lt: 9}, or a regular expression, or any non-expression object (to
// indicate equality).  Returns a branched matcher: a function mapping
// [branched value]->result object.
function compileValueSelector(valueSelector, matcher, isRoot) {
  if (valueSelector instanceof RegExp) {
    matcher._isSimple = false;
    return convertElementMatcherToBranchedMatcher(regexpElementMatcher(valueSelector));
  }

  if (isOperatorObject(valueSelector)) {
    return operatorBranchedMatcher(valueSelector, matcher, isRoot);
  }

  return convertElementMatcherToBranchedMatcher(equalityElementMatcher(valueSelector));
} // Given an element matcher (which evaluates a single value), returns a branched
// value (which evaluates the element matcher on all the branches and returns a
// more structured return value possibly including arrayIndices).


function convertElementMatcherToBranchedMatcher(elementMatcher) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  return branches => {
    const expanded = options.dontExpandLeafArrays ? branches : expandArraysInBranches(branches, options.dontIncludeLeafArrays);
    const match = {};
    match.result = expanded.some(element => {
      let matched = elementMatcher(element.value); // Special case for $elemMatch: it means "true, and use this as an array
      // index if I didn't already have one".

      if (typeof matched === 'number') {
        // XXX This code dates from when we only stored a single array index
        // (for the outermost array). Should we be also including deeper array
        // indices from the $elemMatch match?
        if (!element.arrayIndices) {
          element.arrayIndices = [matched];
        }

        matched = true;
      } // If some element matched, and it's tagged with array indices, include
      // those indices in our result object.


      if (matched && element.arrayIndices) {
        match.arrayIndices = element.arrayIndices;
      }

      return matched;
    });
    return match;
  };
} // Helpers for $near.


function distanceCoordinatePairs(a, b) {
  const pointA = pointToArray(a);
  const pointB = pointToArray(b);
  return Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1]);
} // Takes something that is not an operator object and returns an element matcher
// for equality with that thing.


function equalityElementMatcher(elementSelector) {
  if (isOperatorObject(elementSelector)) {
    throw Error('Can\'t create equalityValueSelector for operator object');
  } // Special-case: null and undefined are equal (if you got undefined in there
  // somewhere, or if you got it due to some branch being non-existent in the
  // weird special case), even though they aren't with EJSON.equals.
  // undefined or null


  if (elementSelector == null) {
    return value => value == null;
  }

  return value => LocalCollection._f._equal(elementSelector, value);
}

function everythingMatcher(docOrBranchedValues) {
  return {
    result: true
  };
}

function expandArraysInBranches(branches, skipTheArrays) {
  const branchesOut = [];
  branches.forEach(branch => {
    const thisIsArray = Array.isArray(branch.value); // We include the branch itself, *UNLESS* we it's an array that we're going
    // to iterate and we're told to skip arrays.  (That's right, we include some
    // arrays even skipTheArrays is true: these are arrays that were found via
    // explicit numerical indices.)

    if (!(skipTheArrays && thisIsArray && !branch.dontIterate)) {
      branchesOut.push({
        arrayIndices: branch.arrayIndices,
        value: branch.value
      });
    }

    if (thisIsArray && !branch.dontIterate) {
      branch.value.forEach((value, i) => {
        branchesOut.push({
          arrayIndices: (branch.arrayIndices || []).concat(i),
          value
        });
      });
    }
  });
  return branchesOut;
}

// Helpers for $bitsAllSet/$bitsAnySet/$bitsAllClear/$bitsAnyClear.
function getOperandBitmask(operand, selector) {
  // numeric bitmask
  // You can provide a numeric bitmask to be matched against the operand field.
  // It must be representable as a non-negative 32-bit signed integer.
  // Otherwise, $bitsAllSet will return an error.
  if (Number.isInteger(operand) && operand >= 0) {
    return new Uint8Array(new Int32Array([operand]).buffer);
  } // bindata bitmask
  // You can also use an arbitrarily large BinData instance as a bitmask.


  if (EJSON.isBinary(operand)) {
    return new Uint8Array(operand.buffer);
  } // position list
  // If querying a list of bit positions, each <position> must be a non-negative
  // integer. Bit positions start at 0 from the least significant bit.


  if (Array.isArray(operand) && operand.every(x => Number.isInteger(x) && x >= 0)) {
    const buffer = new ArrayBuffer((Math.max(...operand) >> 3) + 1);
    const view = new Uint8Array(buffer);
    operand.forEach(x => {
      view[x >> 3] |= 1 << (x & 0x7);
    });
    return view;
  } // bad operand


  throw Error("operand to ".concat(selector, " must be a numeric bitmask (representable as a ") + 'non-negative 32-bit signed integer), a bindata bitmask or an array with ' + 'bit positions (non-negative integers)');
}

function getValueBitmask(value, length) {
  // The field value must be either numerical or a BinData instance. Otherwise,
  // $bits... will not match the current document.
  // numerical
  if (Number.isSafeInteger(value)) {
    // $bits... will not match numerical values that cannot be represented as a
    // signed 64-bit integer. This can be the case if a value is either too
    // large or small to fit in a signed 64-bit integer, or if it has a
    // fractional component.
    const buffer = new ArrayBuffer(Math.max(length, 2 * Uint32Array.BYTES_PER_ELEMENT));
    let view = new Uint32Array(buffer, 0, 2);
    view[0] = value % ((1 << 16) * (1 << 16)) | 0;
    view[1] = value / ((1 << 16) * (1 << 16)) | 0; // sign extension

    if (value < 0) {
      view = new Uint8Array(buffer, 2);
      view.forEach((byte, i) => {
        view[i] = 0xff;
      });
    }

    return new Uint8Array(buffer);
  } // bindata


  if (EJSON.isBinary(value)) {
    return new Uint8Array(value.buffer);
  } // no match


  return false;
} // Actually inserts a key value into the selector document
// However, this checks there is no ambiguity in setting
// the value for the given key, throws otherwise


function insertIntoDocument(document, key, value) {
  Object.keys(document).forEach(existingKey => {
    if (existingKey.length > key.length && existingKey.indexOf("".concat(key, ".")) === 0 || key.length > existingKey.length && key.indexOf("".concat(existingKey, ".")) === 0) {
      throw new Error("cannot infer query fields to set, both paths '".concat(existingKey, "' and ") + "'".concat(key, "' are matched"));
    } else if (existingKey === key) {
      throw new Error("cannot infer query fields to set, path '".concat(key, "' is matched twice"));
    }
  });
  document[key] = value;
} // Returns a branched matcher that matches iff the given matcher does not.
// Note that this implicitly "deMorganizes" the wrapped function.  ie, it
// means that ALL branch values need to fail to match innerBranchedMatcher.


function invertBranchedMatcher(branchedMatcher) {
  return branchValues => {
    // We explicitly choose to strip arrayIndices here: it doesn't make sense to
    // say "update the array element that does not match something", at least
    // in mongo-land.
    return {
      result: !branchedMatcher(branchValues).result
    };
  };
}

function isIndexable(obj) {
  return Array.isArray(obj) || LocalCollection._isPlainObject(obj);
}

function isNumericKey(s) {
  return /^[0-9]+$/.test(s);
}

function isOperatorObject(valueSelector, inconsistentOK) {
  if (!LocalCollection._isPlainObject(valueSelector)) {
    return false;
  }

  let theseAreOperators = undefined;
  Object.keys(valueSelector).forEach(selKey => {
    const thisIsOperator = selKey.substr(0, 1) === '$';

    if (theseAreOperators === undefined) {
      theseAreOperators = thisIsOperator;
    } else if (theseAreOperators !== thisIsOperator) {
      if (!inconsistentOK) {
        throw new Error("Inconsistent operator: ".concat(JSON.stringify(valueSelector)));
      }

      theseAreOperators = false;
    }
  });
  return !!theseAreOperators; // {} has no operators
}

// Helper for $lt/$gt/$lte/$gte.
function makeInequality(cmpValueComparator) {
  return {
    compileElementSelector(operand) {
      // Arrays never compare false with non-arrays for any inequality.
      // XXX This was behavior we observed in pre-release MongoDB 2.5, but
      //     it seems to have been reverted.
      //     See https://jira.mongodb.org/browse/SERVER-11444
      if (Array.isArray(operand)) {
        return () => false;
      } // Special case: consider undefined and null the same (so true with
      // $gte/$lte).


      if (operand === undefined) {
        operand = null;
      }

      const operandType = LocalCollection._f._type(operand);

      return value => {
        if (value === undefined) {
          value = null;
        } // Comparisons are never true among things of different type (except
        // null vs undefined).


        if (LocalCollection._f._type(value) !== operandType) {
          return false;
        }

        return cmpValueComparator(LocalCollection._f._cmp(value, operand));
      };
    }

  };
} // makeLookupFunction(key) returns a lookup function.
//
// A lookup function takes in a document and returns an array of matching
// branches.  If no arrays are found while looking up the key, this array will
// have exactly one branches (possibly 'undefined', if some segment of the key
// was not found).
//
// If arrays are found in the middle, this can have more than one element, since
// we 'branch'. When we 'branch', if there are more key segments to look up,
// then we only pursue branches that are plain objects (not arrays or scalars).
// This means we can actually end up with no branches!
//
// We do *NOT* branch on arrays that are found at the end (ie, at the last
// dotted member of the key). We just return that array; if you want to
// effectively 'branch' over the array's values, post-process the lookup
// function with expandArraysInBranches.
//
// Each branch is an object with keys:
//  - value: the value at the branch
//  - dontIterate: an optional bool; if true, it means that 'value' is an array
//    that expandArraysInBranches should NOT expand. This specifically happens
//    when there is a numeric index in the key, and ensures the
//    perhaps-surprising MongoDB behavior where {'a.0': 5} does NOT
//    match {a: [[5]]}.
//  - arrayIndices: if any array indexing was done during lookup (either due to
//    explicit numeric indices or implicit branching), this will be an array of
//    the array indices used, from outermost to innermost; it is falsey or
//    absent if no array index is used. If an explicit numeric index is used,
//    the index will be followed in arrayIndices by the string 'x'.
//
//    Note: arrayIndices is used for two purposes. First, it is used to
//    implement the '$' modifier feature, which only ever looks at its first
//    element.
//
//    Second, it is used for sort key generation, which needs to be able to tell
//    the difference between different paths. Moreover, it needs to
//    differentiate between explicit and implicit branching, which is why
//    there's the somewhat hacky 'x' entry: this means that explicit and
//    implicit array lookups will have different full arrayIndices paths. (That
//    code only requires that different paths have different arrayIndices; it
//    doesn't actually 'parse' arrayIndices. As an alternative, arrayIndices
//    could contain objects with flags like 'implicit', but I think that only
//    makes the code surrounding them more complex.)
//
//    (By the way, this field ends up getting passed around a lot without
//    cloning, so never mutate any arrayIndices field/var in this package!)
//
//
// At the top level, you may only pass in a plain object or array.
//
// See the test 'minimongo - lookup' for some examples of what lookup functions
// return.


function makeLookupFunction(key) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  const parts = key.split('.');
  const firstPart = parts.length ? parts[0] : '';
  const lookupRest = parts.length > 1 && makeLookupFunction(parts.slice(1).join('.'), options);

  const omitUnnecessaryFields = result => {
    if (!result.dontIterate) {
      delete result.dontIterate;
    }

    if (result.arrayIndices && !result.arrayIndices.length) {
      delete result.arrayIndices;
    }

    return result;
  }; // Doc will always be a plain object or an array.
  // apply an explicit numeric index, an array.


  return function (doc) {
    let arrayIndices = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    if (Array.isArray(doc)) {
      // If we're being asked to do an invalid lookup into an array (non-integer
      // or out-of-bounds), return no results (which is different from returning
      // a single undefined result, in that `null` equality checks won't match).
      if (!(isNumericKey(firstPart) && firstPart < doc.length)) {
        return [];
      } // Remember that we used this array index. Include an 'x' to indicate that
      // the previous index came from being considered as an explicit array
      // index (not branching).


      arrayIndices = arrayIndices.concat(+firstPart, 'x');
    } // Do our first lookup.


    const firstLevel = doc[firstPart]; // If there is no deeper to dig, return what we found.
    //
    // If what we found is an array, most value selectors will choose to treat
    // the elements of the array as matchable values in their own right, but
    // that's done outside of the lookup function. (Exceptions to this are $size
    // and stuff relating to $elemMatch.  eg, {a: {$size: 2}} does not match {a:
    // [[1, 2]]}.)
    //
    // That said, if we just did an *explicit* array lookup (on doc) to find
    // firstLevel, and firstLevel is an array too, we do NOT want value
    // selectors to iterate over it.  eg, {'a.0': 5} does not match {a: [[5]]}.
    // So in that case, we mark the return value as 'don't iterate'.

    if (!lookupRest) {
      return [omitUnnecessaryFields({
        arrayIndices,
        dontIterate: Array.isArray(doc) && Array.isArray(firstLevel),
        value: firstLevel
      })];
    } // We need to dig deeper.  But if we can't, because what we've found is not
    // an array or plain object, we're done. If we just did a numeric index into
    // an array, we return nothing here (this is a change in Mongo 2.5 from
    // Mongo 2.4, where {'a.0.b': null} stopped matching {a: [5]}). Otherwise,
    // return a single `undefined` (which can, for example, match via equality
    // with `null`).


    if (!isIndexable(firstLevel)) {
      if (Array.isArray(doc)) {
        return [];
      }

      return [omitUnnecessaryFields({
        arrayIndices,
        value: undefined
      })];
    }

    const result = [];

    const appendToResult = more => {
      result.push(...more);
    }; // Dig deeper: look up the rest of the parts on whatever we've found.
    // (lookupRest is smart enough to not try to do invalid lookups into
    // firstLevel if it's an array.)


    appendToResult(lookupRest(firstLevel, arrayIndices)); // If we found an array, then in *addition* to potentially treating the next
    // part as a literal integer lookup, we should also 'branch': try to look up
    // the rest of the parts on each array element in parallel.
    //
    // In this case, we *only* dig deeper into array elements that are plain
    // objects. (Recall that we only got this far if we have further to dig.)
    // This makes sense: we certainly don't dig deeper into non-indexable
    // objects. And it would be weird to dig into an array: it's simpler to have
    // a rule that explicit integer indexes only apply to an outer array, not to
    // an array you find after a branching search.
    //
    // In the special case of a numeric part in a *sort selector* (not a query
    // selector), we skip the branching: we ONLY allow the numeric part to mean
    // 'look up this index' in that case, not 'also look up this index in all
    // the elements of the array'.

    if (Array.isArray(firstLevel) && !(isNumericKey(parts[1]) && options.forSort)) {
      firstLevel.forEach((branch, arrayIndex) => {
        if (LocalCollection._isPlainObject(branch)) {
          appendToResult(lookupRest(branch, arrayIndices.concat(arrayIndex)));
        }
      });
    }

    return result;
  };
}

// Object exported only for unit testing.
// Use it to export private functions to test in Tinytest.
MinimongoTest = {
  makeLookupFunction
};

MinimongoError = function (message) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  if (typeof message === 'string' && options.field) {
    message += " for field '".concat(options.field, "'");
  }

  const error = new Error(message);
  error.name = 'MinimongoError';
  return error;
};

function nothingMatcher(docOrBranchedValues) {
  return {
    result: false
  };
}

// Takes an operator object (an object with $ keys) and returns a branched
// matcher for it.
function operatorBranchedMatcher(valueSelector, matcher, isRoot) {
  // Each valueSelector works separately on the various branches.  So one
  // operator can match one branch and another can match another branch.  This
  // is OK.
  const operatorMatchers = Object.keys(valueSelector).map(operator => {
    const operand = valueSelector[operator];
    const simpleRange = ['$lt', '$lte', '$gt', '$gte'].includes(operator) && typeof operand === 'number';
    const simpleEquality = ['$ne', '$eq'].includes(operator) && operand !== Object(operand);
    const simpleInclusion = ['$in', '$nin'].includes(operator) && Array.isArray(operand) && !operand.some(x => x === Object(x));

    if (!(simpleRange || simpleInclusion || simpleEquality)) {
      matcher._isSimple = false;
    }

    if (hasOwn.call(VALUE_OPERATORS, operator)) {
      return VALUE_OPERATORS[operator](operand, valueSelector, matcher, isRoot);
    }

    if (hasOwn.call(ELEMENT_OPERATORS, operator)) {
      const options = ELEMENT_OPERATORS[operator];
      return convertElementMatcherToBranchedMatcher(options.compileElementSelector(operand, valueSelector, matcher), options);
    }

    throw new Error("Unrecognized operator: ".concat(operator));
  });
  return andBranchedMatchers(operatorMatchers);
} // paths - Array: list of mongo style paths
// newLeafFn - Function: of form function(path) should return a scalar value to
//                       put into list created for that path
// conflictFn - Function: of form function(node, path, fullPath) is called
//                        when building a tree path for 'fullPath' node on
//                        'path' was already a leaf with a value. Must return a
//                        conflict resolution.
// initial tree - Optional Object: starting tree.
// @returns - Object: tree represented as a set of nested objects


function pathsToTree(paths, newLeafFn, conflictFn) {
  let root = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {};
  paths.forEach(path => {
    const pathArray = path.split('.');
    let tree = root; // use .every just for iteration with break

    const success = pathArray.slice(0, -1).every((key, i) => {
      if (!hasOwn.call(tree, key)) {
        tree[key] = {};
      } else if (tree[key] !== Object(tree[key])) {
        tree[key] = conflictFn(tree[key], pathArray.slice(0, i + 1).join('.'), path); // break out of loop if we are failing for this path

        if (tree[key] !== Object(tree[key])) {
          return false;
        }
      }

      tree = tree[key];
      return true;
    });

    if (success) {
      const lastKey = pathArray[pathArray.length - 1];

      if (hasOwn.call(tree, lastKey)) {
        tree[lastKey] = conflictFn(tree[lastKey], path, path);
      } else {
        tree[lastKey] = newLeafFn(path);
      }
    }
  });
  return root;
}

// Makes sure we get 2 elements array and assume the first one to be x and
// the second one to y no matter what user passes.
// In case user passes { lon: x, lat: y } returns [x, y]
function pointToArray(point) {
  return Array.isArray(point) ? point.slice() : [point.x, point.y];
} // Creating a document from an upsert is quite tricky.
// E.g. this selector: {"$or": [{"b.foo": {"$all": ["bar"]}}]}, should result
// in: {"b.foo": "bar"}
// But this selector: {"$or": [{"b": {"foo": {"$all": ["bar"]}}}]} should throw
// an error
// Some rules (found mainly with trial & error, so there might be more):
// - handle all childs of $and (or implicit $and)
// - handle $or nodes with exactly 1 child
// - ignore $or nodes with more than 1 child
// - ignore $nor and $not nodes
// - throw when a value can not be set unambiguously
// - every value for $all should be dealt with as separate $eq-s
// - threat all children of $all as $eq setters (=> set if $all.length === 1,
//   otherwise throw error)
// - you can not mix '$'-prefixed keys and non-'$'-prefixed keys
// - you can only have dotted keys on a root-level
// - you can not have '$'-prefixed keys more than one-level deep in an object
// Handles one key/value pair to put in the selector document


function populateDocumentWithKeyValue(document, key, value) {
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    populateDocumentWithObject(document, key, value);
  } else if (!(value instanceof RegExp)) {
    insertIntoDocument(document, key, value);
  }
} // Handles a key, value pair to put in the selector document
// if the value is an object


function populateDocumentWithObject(document, key, value) {
  const keys = Object.keys(value);
  const unprefixedKeys = keys.filter(op => op[0] !== '$');

  if (unprefixedKeys.length > 0 || !keys.length) {
    // Literal (possibly empty) object ( or empty object )
    // Don't allow mixing '$'-prefixed with non-'$'-prefixed fields
    if (keys.length !== unprefixedKeys.length) {
      throw new Error("unknown operator: ".concat(unprefixedKeys[0]));
    }

    validateObject(value, key);
    insertIntoDocument(document, key, value);
  } else {
    Object.keys(value).forEach(op => {
      const object = value[op];

      if (op === '$eq') {
        populateDocumentWithKeyValue(document, key, object);
      } else if (op === '$all') {
        // every value for $all should be dealt with as separate $eq-s
        object.forEach(element => populateDocumentWithKeyValue(document, key, element));
      }
    });
  }
} // Fills a document with certain fields from an upsert selector


function populateDocumentWithQueryFields(query) {
  let document = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  if (Object.getPrototypeOf(query) === Object.prototype) {
    // handle implicit $and
    Object.keys(query).forEach(key => {
      const value = query[key];

      if (key === '$and') {
        // handle explicit $and
        value.forEach(element => populateDocumentWithQueryFields(element, document));
      } else if (key === '$or') {
        // handle $or nodes with exactly 1 child
        if (value.length === 1) {
          populateDocumentWithQueryFields(value[0], document);
        }
      } else if (key[0] !== '$') {
        // Ignore other '$'-prefixed logical selectors
        populateDocumentWithKeyValue(document, key, value);
      }
    });
  } else {
    // Handle meteor-specific shortcut for selecting _id
    if (LocalCollection._selectorIsId(query)) {
      insertIntoDocument(document, '_id', query);
    }
  }

  return document;
}

function projectionDetails(fields) {
  // Find the non-_id keys (_id is handled specially because it is included
  // unless explicitly excluded). Sort the keys, so that our code to detect
  // overlaps like 'foo' and 'foo.bar' can assume that 'foo' comes first.
  let fieldsKeys = Object.keys(fields).sort(); // If _id is the only field in the projection, do not remove it, since it is
  // required to determine if this is an exclusion or exclusion. Also keep an
  // inclusive _id, since inclusive _id follows the normal rules about mixing
  // inclusive and exclusive fields. If _id is not the only field in the
  // projection and is exclusive, remove it so it can be handled later by a
  // special case, since exclusive _id is always allowed.

  if (!(fieldsKeys.length === 1 && fieldsKeys[0] === '_id') && !(fieldsKeys.includes('_id') && fields._id)) {
    fieldsKeys = fieldsKeys.filter(key => key !== '_id');
  }

  let including = null; // Unknown

  fieldsKeys.forEach(keyPath => {
    const rule = !!fields[keyPath];

    if (including === null) {
      including = rule;
    } // This error message is copied from MongoDB shell


    if (including !== rule) {
      throw MinimongoError('You cannot currently mix including and excluding fields.');
    }
  });
  const projectionRulesTree = pathsToTree(fieldsKeys, path => including, (node, path, fullPath) => {
    // Check passed projection fields' keys: If you have two rules such as
    // 'foo.bar' and 'foo.bar.baz', then the result becomes ambiguous. If
    // that happens, there is a probability you are doing something wrong,
    // framework should notify you about such mistake earlier on cursor
    // compilation step than later during runtime.  Note, that real mongo
    // doesn't do anything about it and the later rule appears in projection
    // project, more priority it takes.
    //
    // Example, assume following in mongo shell:
    // > db.coll.insert({ a: { b: 23, c: 44 } })
    // > db.coll.find({}, { 'a': 1, 'a.b': 1 })
    // {"_id": ObjectId("520bfe456024608e8ef24af3"), "a": {"b": 23}}
    // > db.coll.find({}, { 'a.b': 1, 'a': 1 })
    // {"_id": ObjectId("520bfe456024608e8ef24af3"), "a": {"b": 23, "c": 44}}
    //
    // Note, how second time the return set of keys is different.
    const currentPath = fullPath;
    const anotherPath = path;
    throw MinimongoError("both ".concat(currentPath, " and ").concat(anotherPath, " found in fields option, ") + 'using both of them may trigger unexpected behavior. Did you mean to ' + 'use only one of them?');
  });
  return {
    including,
    tree: projectionRulesTree
  };
}

function regexpElementMatcher(regexp) {
  return value => {
    if (value instanceof RegExp) {
      return value.toString() === regexp.toString();
    } // Regexps only work against strings.


    if (typeof value !== 'string') {
      return false;
    } // Reset regexp's state to avoid inconsistent matching for objects with the
    // same value on consecutive calls of regexp.test. This happens only if the
    // regexp has the 'g' flag. Also note that ES6 introduces a new flag 'y' for
    // which we should *not* change the lastIndex but MongoDB doesn't support
    // either of these flags.


    regexp.lastIndex = 0;
    return regexp.test(value);
  };
}

// Validates the key in a path.
// Objects that are nested more then 1 level cannot have dotted fields
// or fields starting with '$'
function validateKeyInPath(key, path) {
  if (key.includes('.')) {
    throw new Error("The dotted field '".concat(key, "' in '").concat(path, ".").concat(key, " is not valid for storage."));
  }

  if (key[0] === '$') {
    throw new Error("The dollar ($) prefixed field  '".concat(path, ".").concat(key, " is not valid for storage."));
  }
} // Recursively validates an object that is nested more than one level deep


function validateObject(object, path) {
  if (object && Object.getPrototypeOf(object) === Object.prototype) {
    Object.keys(object).forEach(key => {
      validateKeyInPath(key, path);
      validateObject(object[key], path + '.' + key);
    });
  }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"cursor.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/cursor.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => Cursor
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }

}, 0);
let hasOwn;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  }

}, 1);

class Cursor {
  // don't call this ctor directly.  use LocalCollection.find().
  constructor(collection, selector) {
    let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
    this.collection = collection;
    this.sorter = null;
    this.matcher = new Minimongo.Matcher(selector);

    if (LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
      // stash for fast _id and { _id }
      this._selectorId = hasOwn.call(selector, '_id') ? selector._id : selector;
    } else {
      this._selectorId = undefined;

      if (this.matcher.hasGeoQuery() || options.sort) {
        this.sorter = new Minimongo.Sorter(options.sort || []);
      }
    }

    this.skip = options.skip || 0;
    this.limit = options.limit;
    this.fields = options.fields;
    this._projectionFn = LocalCollection._compileProjection(this.fields || {});
    this._transform = LocalCollection.wrapTransform(options.transform); // by default, queries register w/ Tracker when it is available.

    if (typeof Tracker !== 'undefined') {
      this.reactive = options.reactive === undefined ? true : options.reactive;
    }
  }
  /**
   * @summary Returns the number of documents that match a query.
   * @memberOf Mongo.Cursor
   * @method  count
   * @param {boolean} [applySkipLimit=true] If set to `false`, the value
   *                                         returned will reflect the total
   *                                         number of matching documents,
   *                                         ignoring any value supplied for
   *                                         limit
   * @instance
   * @locus Anywhere
   * @returns {Number}
   */


  count() {
    let applySkipLimit = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : true;

    if (this.reactive) {
      // allow the observe to be unordered
      this._depend({
        added: true,
        removed: true
      }, true);
    }

    return this._getRawObjects({
      ordered: true,
      applySkipLimit
    }).length;
  }
  /**
   * @summary Return all matching documents as an Array.
   * @memberOf Mongo.Cursor
   * @method  fetch
   * @instance
   * @locus Anywhere
   * @returns {Object[]}
   */


  fetch() {
    const result = [];
    this.forEach(doc => {
      result.push(doc);
    });
    return result;
  }

  [Symbol.iterator]() {
    if (this.reactive) {
      this._depend({
        addedBefore: true,
        removed: true,
        changed: true,
        movedBefore: true
      });
    }

    let index = 0;

    const objects = this._getRawObjects({
      ordered: true
    });

    return {
      next: () => {
        if (index < objects.length) {
          // This doubles as a clone operation.
          let element = this._projectionFn(objects[index++]);

          if (this._transform) element = this._transform(element);
          return {
            value: element
          };
        }

        return {
          done: true
        };
      }
    };
  }
  /**
   * @callback IterationCallback
   * @param {Object} doc
   * @param {Number} index
   */

  /**
   * @summary Call `callback` once for each matching document, sequentially and
   *          synchronously.
   * @locus Anywhere
   * @method  forEach
   * @instance
   * @memberOf Mongo.Cursor
   * @param {IterationCallback} callback Function to call. It will be called
   *                                     with three arguments: the document, a
   *                                     0-based index, and <em>cursor</em>
   *                                     itself.
   * @param {Any} [thisArg] An object which will be the value of `this` inside
   *                        `callback`.
   */


  forEach(callback, thisArg) {
    if (this.reactive) {
      this._depend({
        addedBefore: true,
        removed: true,
        changed: true,
        movedBefore: true
      });
    }

    this._getRawObjects({
      ordered: true
    }).forEach((element, i) => {
      // This doubles as a clone operation.
      element = this._projectionFn(element);

      if (this._transform) {
        element = this._transform(element);
      }

      callback.call(thisArg, element, i, this);
    });
  }

  getTransform() {
    return this._transform;
  }
  /**
   * @summary Map callback over all matching documents.  Returns an Array.
   * @locus Anywhere
   * @method map
   * @instance
   * @memberOf Mongo.Cursor
   * @param {IterationCallback} callback Function to call. It will be called
   *                                     with three arguments: the document, a
   *                                     0-based index, and <em>cursor</em>
   *                                     itself.
   * @param {Any} [thisArg] An object which will be the value of `this` inside
   *                        `callback`.
   */


  map(callback, thisArg) {
    const result = [];
    this.forEach((doc, i) => {
      result.push(callback.call(thisArg, doc, i, this));
    });
    return result;
  } // options to contain:
  //  * callbacks for observe():
  //    - addedAt (document, atIndex)
  //    - added (document)
  //    - changedAt (newDocument, oldDocument, atIndex)
  //    - changed (newDocument, oldDocument)
  //    - removedAt (document, atIndex)
  //    - removed (document)
  //    - movedTo (document, oldIndex, newIndex)
  //
  // attributes available on returned query handle:
  //  * stop(): end updates
  //  * collection: the collection this query is querying
  //
  // iff x is a returned query handle, (x instanceof
  // LocalCollection.ObserveHandle) is true
  //
  // initial results delivered through added callback
  // XXX maybe callbacks should take a list of objects, to expose transactions?
  // XXX maybe support field limiting (to limit what you're notified on)

  /**
   * @summary Watch a query.  Receive callbacks as the result set changes.
   * @locus Anywhere
   * @memberOf Mongo.Cursor
   * @instance
   * @param {Object} callbacks Functions to call to deliver the result set as it
   *                           changes
   */


  observe(options) {
    return LocalCollection._observeFromObserveChanges(this, options);
  }
  /**
   * @summary Watch a query. Receive callbacks as the result set changes. Only
   *          the differences between the old and new documents are passed to
   *          the callbacks.
   * @locus Anywhere
   * @memberOf Mongo.Cursor
   * @instance
   * @param {Object} callbacks Functions to call to deliver the result set as it
   *                           changes
   */


  observeChanges(options) {
    const ordered = LocalCollection._observeChangesCallbacksAreOrdered(options); // there are several places that assume you aren't combining skip/limit with
    // unordered observe.  eg, update's EJSON.clone, and the "there are several"
    // comment in _modifyAndNotify
    // XXX allow skip/limit with unordered observe


    if (!options._allow_unordered && !ordered && (this.skip || this.limit)) {
      throw new Error("Must use an ordered observe with skip or limit (i.e. 'addedBefore' " + "for observeChanges or 'addedAt' for observe, instead of 'added').");
    }

    if (this.fields && (this.fields._id === 0 || this.fields._id === false)) {
      throw Error('You may not observe a cursor with {fields: {_id: 0}}');
    }

    const distances = this.matcher.hasGeoQuery() && ordered && new LocalCollection._IdMap();
    const query = {
      cursor: this,
      dirty: false,
      distances,
      matcher: this.matcher,
      // not fast pathed
      ordered,
      projectionFn: this._projectionFn,
      resultsSnapshot: null,
      sorter: ordered && this.sorter
    };
    let qid; // Non-reactive queries call added[Before] and then never call anything
    // else.

    if (this.reactive) {
      qid = this.collection.next_qid++;
      this.collection.queries[qid] = query;
    }

    query.results = this._getRawObjects({
      ordered,
      distances: query.distances
    });

    if (this.collection.paused) {
      query.resultsSnapshot = ordered ? [] : new LocalCollection._IdMap();
    } // wrap callbacks we were passed. callbacks only fire when not paused and
    // are never undefined
    // Filters out blacklisted fields according to cursor's projection.
    // XXX wrong place for this?
    // furthermore, callbacks enqueue until the operation we're working on is
    // done.


    const wrapCallback = fn => {
      if (!fn) {
        return () => {};
      }

      const self = this;
      return function ()
      /* args*/
      {
        if (self.collection.paused) {
          return;
        }

        const args = arguments;

        self.collection._observeQueue.queueTask(() => {
          fn.apply(this, args);
        });
      };
    };

    query.added = wrapCallback(options.added);
    query.changed = wrapCallback(options.changed);
    query.removed = wrapCallback(options.removed);

    if (ordered) {
      query.addedBefore = wrapCallback(options.addedBefore);
      query.movedBefore = wrapCallback(options.movedBefore);
    }

    if (!options._suppress_initial && !this.collection.paused) {
      query.results.forEach(doc => {
        const fields = EJSON.clone(doc);
        delete fields._id;

        if (ordered) {
          query.addedBefore(doc._id, this._projectionFn(fields), null);
        }

        query.added(doc._id, this._projectionFn(fields));
      });
    }

    const handle = Object.assign(new LocalCollection.ObserveHandle(), {
      collection: this.collection,
      stop: () => {
        if (this.reactive) {
          delete this.collection.queries[qid];
        }
      }
    });

    if (this.reactive && Tracker.active) {
      // XXX in many cases, the same observe will be recreated when
      // the current autorun is rerun.  we could save work by
      // letting it linger across rerun and potentially get
      // repurposed if the same observe is performed, using logic
      // similar to that of Meteor.subscribe.
      Tracker.onInvalidate(() => {
        handle.stop();
      });
    } // run the observe callbacks resulting from the initial contents
    // before we leave the observe.


    this.collection._observeQueue.drain();

    return handle;
  } // XXX Maybe we need a version of observe that just calls a callback if
  // anything changed.


  _depend(changers, _allow_unordered) {
    if (Tracker.active) {
      const dependency = new Tracker.Dependency();
      const notify = dependency.changed.bind(dependency);
      dependency.depend();
      const options = {
        _allow_unordered,
        _suppress_initial: true
      };
      ['added', 'addedBefore', 'changed', 'movedBefore', 'removed'].forEach(fn => {
        if (changers[fn]) {
          options[fn] = notify;
        }
      }); // observeChanges will stop() when this computation is invalidated

      this.observeChanges(options);
    }
  }

  _getCollectionName() {
    return this.collection.name;
  } // Returns a collection of matching objects, but doesn't deep copy them.
  //
  // If ordered is set, returns a sorted array, respecting sorter, skip, and
  // limit properties of the query provided that options.applySkipLimit is
  // not set to false (#1201). If sorter is falsey, no sort -- you get the
  // natural order.
  //
  // If ordered is not set, returns an object mapping from ID to doc (sorter,
  // skip and limit should not be set).
  //
  // If ordered is set and this cursor is a $near geoquery, then this function
  // will use an _IdMap to track each distance from the $near argument point in
  // order to use it as a sort key. If an _IdMap is passed in the 'distances'
  // argument, this function will clear it and use it for this purpose
  // (otherwise it will just create its own _IdMap). The observeChanges
  // implementation uses this to remember the distances after this function
  // returns.


  _getRawObjects() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    // By default this method will respect skip and limit because .fetch(),
    // .forEach() etc... expect this behaviour. It can be forced to ignore
    // skip and limit by setting applySkipLimit to false (.count() does this,
    // for example)
    const applySkipLimit = options.applySkipLimit !== false; // XXX use OrderedDict instead of array, and make IdMap and OrderedDict
    // compatible

    const results = options.ordered ? [] : new LocalCollection._IdMap(); // fast path for single ID value

    if (this._selectorId !== undefined) {
      // If you have non-zero skip and ask for a single id, you get nothing.
      // This is so it matches the behavior of the '{_id: foo}' path.
      if (applySkipLimit && this.skip) {
        return results;
      }

      const selectedDoc = this.collection._docs.get(this._selectorId);

      if (selectedDoc) {
        if (options.ordered) {
          results.push(selectedDoc);
        } else {
          results.set(this._selectorId, selectedDoc);
        }
      }

      return results;
    } // slow path for arbitrary selector, sort, skip, limit
    // in the observeChanges case, distances is actually part of the "query"
    // (ie, live results set) object.  in other cases, distances is only used
    // inside this function.


    let distances;

    if (this.matcher.hasGeoQuery() && options.ordered) {
      if (options.distances) {
        distances = options.distances;
        distances.clear();
      } else {
        distances = new LocalCollection._IdMap();
      }
    }

    this.collection._docs.forEach((doc, id) => {
      const matchResult = this.matcher.documentMatches(doc);

      if (matchResult.result) {
        if (options.ordered) {
          results.push(doc);

          if (distances && matchResult.distance !== undefined) {
            distances.set(id, matchResult.distance);
          }
        } else {
          results.set(id, doc);
        }
      } // Override to ensure all docs are matched if ignoring skip & limit


      if (!applySkipLimit) {
        return true;
      } // Fast path for limited unsorted queries.
      // XXX 'length' check here seems wrong for ordered


      return !this.limit || this.skip || this.sorter || results.length !== this.limit;
    });

    if (!options.ordered) {
      return results;
    }

    if (this.sorter) {
      results.sort(this.sorter.getComparator({
        distances
      }));
    } // Return the full set of results if there is no skip or limit or if we're
    // ignoring them


    if (!applySkipLimit || !this.limit && !this.skip) {
      return results;
    }

    return results.slice(this.skip, this.limit ? this.limit + this.skip : results.length);
  }

  _publishCursor(subscription) {
    // XXX minimongo should not depend on mongo-livedata!
    if (!Package.mongo) {
      throw new Error('Can\'t publish from Minimongo without the `mongo` package.');
    }

    if (!this.collection.name) {
      throw new Error('Can\'t publish a cursor from a collection without a name.');
    }

    return Package.mongo.Mongo.Collection._publishCursor(this, subscription, this.collection.name);
  }

}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"local_collection.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/local_collection.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let _objectSpread;

module.link("@babel/runtime/helpers/objectSpread2", {
  default(v) {
    _objectSpread = v;
  }

}, 0);
module.export({
  default: () => LocalCollection
});
let Cursor;
module.link("./cursor.js", {
  default(v) {
    Cursor = v;
  }

}, 0);
let ObserveHandle;
module.link("./observe_handle.js", {
  default(v) {
    ObserveHandle = v;
  }

}, 1);
let hasOwn, isIndexable, isNumericKey, isOperatorObject, populateDocumentWithQueryFields, projectionDetails;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  },

  isIndexable(v) {
    isIndexable = v;
  },

  isNumericKey(v) {
    isNumericKey = v;
  },

  isOperatorObject(v) {
    isOperatorObject = v;
  },

  populateDocumentWithQueryFields(v) {
    populateDocumentWithQueryFields = v;
  },

  projectionDetails(v) {
    projectionDetails = v;
  }

}, 2);

class LocalCollection {
  constructor(name) {
    this.name = name; // _id -> document (also containing id)

    this._docs = new LocalCollection._IdMap();
    this._observeQueue = new Meteor._SynchronousQueue();
    this.next_qid = 1; // live query id generator
    // qid -> live query object. keys:
    //  ordered: bool. ordered queries have addedBefore/movedBefore callbacks.
    //  results: array (ordered) or object (unordered) of current results
    //    (aliased with this._docs!)
    //  resultsSnapshot: snapshot of results. null if not paused.
    //  cursor: Cursor object for the query.
    //  selector, sorter, (callbacks): functions

    this.queries = Object.create(null); // null if not saving originals; an IdMap from id to original document value
    // if saving originals. See comments before saveOriginals().

    this._savedOriginals = null; // True when observers are paused and we should not send callbacks.

    this.paused = false;
  } // options may include sort, skip, limit, reactive
  // sort may be any of these forms:
  //     {a: 1, b: -1}
  //     [["a", "asc"], ["b", "desc"]]
  //     ["a", ["b", "desc"]]
  //   (in the first form you're beholden to key enumeration order in
  //   your javascript VM)
  //
  // reactive: if given, and false, don't register with Tracker (default
  // is true)
  //
  // XXX possibly should support retrieving a subset of fields? and
  // have it be a hint (ignored on the client, when not copying the
  // doc?)
  //
  // XXX sort does not yet support subkeys ('a.b') .. fix that!
  // XXX add one more sort form: "key"
  // XXX tests


  find(selector, options) {
    // default syntax for everything is to omit the selector argument.
    // but if selector is explicitly passed in as false or undefined, we
    // want a selector that matches nothing.
    if (arguments.length === 0) {
      selector = {};
    }

    return new LocalCollection.Cursor(this, selector, options);
  }

  findOne(selector) {
    let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

    if (arguments.length === 0) {
      selector = {};
    } // NOTE: by setting limit 1 here, we end up using very inefficient
    // code that recomputes the whole query on each update. The upside is
    // that when you reactively depend on a findOne you only get
    // invalidated when the found object changes, not any object in the
    // collection. Most findOne will be by id, which has a fast path, so
    // this might not be a big deal. In most cases, invalidation causes
    // the called to re-query anyway, so this should be a net performance
    // improvement.


    options.limit = 1;
    return this.find(selector, options).fetch()[0];
  } // XXX possibly enforce that 'undefined' does not appear (we assume
  // this in our handling of null and $exists)


  insert(doc, callback) {
    doc = EJSON.clone(doc);
    assertHasValidFieldNames(doc); // if you really want to use ObjectIDs, set this global.
    // Mongo.Collection specifies its own ids and does not use this code.

    if (!hasOwn.call(doc, '_id')) {
      doc._id = LocalCollection._useOID ? new MongoID.ObjectID() : Random.id();
    }

    const id = doc._id;

    if (this._docs.has(id)) {
      throw MinimongoError("Duplicate _id '".concat(id, "'"));
    }

    this._saveOriginal(id, undefined);

    this._docs.set(id, doc);

    const queriesToRecompute = []; // trigger live queries that match

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        return;
      }

      const matchResult = query.matcher.documentMatches(doc);

      if (matchResult.result) {
        if (query.distances && matchResult.distance !== undefined) {
          query.distances.set(id, matchResult.distance);
        }

        if (query.cursor.skip || query.cursor.limit) {
          queriesToRecompute.push(qid);
        } else {
          LocalCollection._insertInResults(query, doc);
        }
      }
    });
    queriesToRecompute.forEach(qid => {
      if (this.queries[qid]) {
        this._recomputeResults(this.queries[qid]);
      }
    });

    this._observeQueue.drain(); // Defer because the caller likely doesn't expect the callback to be run
    // immediately.


    if (callback) {
      Meteor.defer(() => {
        callback(null, id);
      });
    }

    return id;
  } // Pause the observers. No callbacks from observers will fire until
  // 'resumeObservers' is called.


  pauseObservers() {
    // No-op if already paused.
    if (this.paused) {
      return;
    } // Set the 'paused' flag such that new observer messages don't fire.


    this.paused = true; // Take a snapshot of the query results for each query.

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      query.resultsSnapshot = EJSON.clone(query.results);
    });
  }

  remove(selector, callback) {
    // Easy special case: if we're not calling observeChanges callbacks and
    // we're not saving originals and we got asked to remove everything, then
    // just empty everything directly.
    if (this.paused && !this._savedOriginals && EJSON.equals(selector, {})) {
      const result = this._docs.size();

      this._docs.clear();

      Object.keys(this.queries).forEach(qid => {
        const query = this.queries[qid];

        if (query.ordered) {
          query.results = [];
        } else {
          query.results.clear();
        }
      });

      if (callback) {
        Meteor.defer(() => {
          callback(null, result);
        });
      }

      return result;
    }

    const matcher = new Minimongo.Matcher(selector);
    const remove = [];

    this._eachPossiblyMatchingDoc(selector, (doc, id) => {
      if (matcher.documentMatches(doc).result) {
        remove.push(id);
      }
    });

    const queriesToRecompute = [];
    const queryRemove = [];

    for (let i = 0; i < remove.length; i++) {
      const removeId = remove[i];

      const removeDoc = this._docs.get(removeId);

      Object.keys(this.queries).forEach(qid => {
        const query = this.queries[qid];

        if (query.dirty) {
          return;
        }

        if (query.matcher.documentMatches(removeDoc).result) {
          if (query.cursor.skip || query.cursor.limit) {
            queriesToRecompute.push(qid);
          } else {
            queryRemove.push({
              qid,
              doc: removeDoc
            });
          }
        }
      });

      this._saveOriginal(removeId, removeDoc);

      this._docs.remove(removeId);
    } // run live query callbacks _after_ we've removed the documents.


    queryRemove.forEach(remove => {
      const query = this.queries[remove.qid];

      if (query) {
        query.distances && query.distances.remove(remove.doc._id);

        LocalCollection._removeFromResults(query, remove.doc);
      }
    });
    queriesToRecompute.forEach(qid => {
      const query = this.queries[qid];

      if (query) {
        this._recomputeResults(query);
      }
    });

    this._observeQueue.drain();

    const result = remove.length;

    if (callback) {
      Meteor.defer(() => {
        callback(null, result);
      });
    }

    return result;
  } // Resume the observers. Observers immediately receive change
  // notifications to bring them to the current state of the
  // database. Note that this is not just replaying all the changes that
  // happened during the pause, it is a smarter 'coalesced' diff.


  resumeObservers() {
    // No-op if not paused.
    if (!this.paused) {
      return;
    } // Unset the 'paused' flag. Make sure to do this first, otherwise
    // observer methods won't actually fire when we trigger them.


    this.paused = false;
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        query.dirty = false; // re-compute results will perform `LocalCollection._diffQueryChanges`
        // automatically.

        this._recomputeResults(query, query.resultsSnapshot);
      } else {
        // Diff the current results against the snapshot and send to observers.
        // pass the query object for its observer callbacks.
        LocalCollection._diffQueryChanges(query.ordered, query.resultsSnapshot, query.results, query, {
          projectionFn: query.projectionFn
        });
      }

      query.resultsSnapshot = null;
    });

    this._observeQueue.drain();
  }

  retrieveOriginals() {
    if (!this._savedOriginals) {
      throw new Error('Called retrieveOriginals without saveOriginals');
    }

    const originals = this._savedOriginals;
    this._savedOriginals = null;
    return originals;
  } // To track what documents are affected by a piece of code, call
  // saveOriginals() before it and retrieveOriginals() after it.
  // retrieveOriginals returns an object whose keys are the ids of the documents
  // that were affected since the call to saveOriginals(), and the values are
  // equal to the document's contents at the time of saveOriginals. (In the case
  // of an inserted document, undefined is the value.) You must alternate
  // between calls to saveOriginals() and retrieveOriginals().


  saveOriginals() {
    if (this._savedOriginals) {
      throw new Error('Called saveOriginals twice without retrieveOriginals');
    }

    this._savedOriginals = new LocalCollection._IdMap();
  } // XXX atomicity: if multi is true, and one modification fails, do
  // we rollback the whole operation, or what?


  update(selector, mod, options, callback) {
    if (!callback && options instanceof Function) {
      callback = options;
      options = null;
    }

    if (!options) {
      options = {};
    }

    const matcher = new Minimongo.Matcher(selector, true); // Save the original results of any query that we might need to
    // _recomputeResults on, because _modifyAndNotify will mutate the objects in
    // it. (We don't need to save the original results of paused queries because
    // they already have a resultsSnapshot and we won't be diffing in
    // _recomputeResults.)

    const qidToOriginalResults = {}; // We should only clone each document once, even if it appears in multiple
    // queries

    const docMap = new LocalCollection._IdMap();

    const idsMatched = LocalCollection._idsMatchedBySelector(selector);

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if ((query.cursor.skip || query.cursor.limit) && !this.paused) {
        // Catch the case of a reactive `count()` on a cursor with skip
        // or limit, which registers an unordered observe. This is a
        // pretty rare case, so we just clone the entire result set with
        // no optimizations for documents that appear in these result
        // sets and other queries.
        if (query.results instanceof LocalCollection._IdMap) {
          qidToOriginalResults[qid] = query.results.clone();
          return;
        }

        if (!(query.results instanceof Array)) {
          throw new Error('Assertion failed: query.results not an array');
        } // Clones a document to be stored in `qidToOriginalResults`
        // because it may be modified before the new and old result sets
        // are diffed. But if we know exactly which document IDs we're
        // going to modify, then we only need to clone those.


        const memoizedCloneIfNeeded = doc => {
          if (docMap.has(doc._id)) {
            return docMap.get(doc._id);
          }

          const docToMemoize = idsMatched && !idsMatched.some(id => EJSON.equals(id, doc._id)) ? doc : EJSON.clone(doc);
          docMap.set(doc._id, docToMemoize);
          return docToMemoize;
        };

        qidToOriginalResults[qid] = query.results.map(memoizedCloneIfNeeded);
      }
    });
    const recomputeQids = {};
    let updateCount = 0;

    this._eachPossiblyMatchingDoc(selector, (doc, id) => {
      const queryResult = matcher.documentMatches(doc);

      if (queryResult.result) {
        // XXX Should we save the original even if mod ends up being a no-op?
        this._saveOriginal(id, doc);

        this._modifyAndNotify(doc, mod, recomputeQids, queryResult.arrayIndices);

        ++updateCount;

        if (!options.multi) {
          return false; // break
        }
      }

      return true;
    });

    Object.keys(recomputeQids).forEach(qid => {
      const query = this.queries[qid];

      if (query) {
        this._recomputeResults(query, qidToOriginalResults[qid]);
      }
    });

    this._observeQueue.drain(); // If we are doing an upsert, and we didn't modify any documents yet, then
    // it's time to do an insert. Figure out what document we are inserting, and
    // generate an id for it.


    let insertedId;

    if (updateCount === 0 && options.upsert) {
      const doc = LocalCollection._createUpsertDocument(selector, mod);

      if (!doc._id && options.insertedId) {
        doc._id = options.insertedId;
      }

      insertedId = this.insert(doc);
      updateCount = 1;
    } // Return the number of affected documents, or in the upsert case, an object
    // containing the number of affected docs and the id of the doc that was
    // inserted, if any.


    let result;

    if (options._returnObject) {
      result = {
        numberAffected: updateCount
      };

      if (insertedId !== undefined) {
        result.insertedId = insertedId;
      }
    } else {
      result = updateCount;
    }

    if (callback) {
      Meteor.defer(() => {
        callback(null, result);
      });
    }

    return result;
  } // A convenience wrapper on update. LocalCollection.upsert(sel, mod) is
  // equivalent to LocalCollection.update(sel, mod, {upsert: true,
  // _returnObject: true}).


  upsert(selector, mod, options, callback) {
    if (!callback && typeof options === 'function') {
      callback = options;
      options = {};
    }

    return this.update(selector, mod, Object.assign({}, options, {
      upsert: true,
      _returnObject: true
    }), callback);
  } // Iterates over a subset of documents that could match selector; calls
  // fn(doc, id) on each of them.  Specifically, if selector specifies
  // specific _id's, it only looks at those.  doc is *not* cloned: it is the
  // same object that is in _docs.


  _eachPossiblyMatchingDoc(selector, fn) {
    const specificIds = LocalCollection._idsMatchedBySelector(selector);

    if (specificIds) {
      specificIds.some(id => {
        const doc = this._docs.get(id);

        if (doc) {
          return fn(doc, id) === false;
        }
      });
    } else {
      this._docs.forEach(fn);
    }
  }

  _modifyAndNotify(doc, mod, recomputeQids, arrayIndices) {
    const matched_before = {};
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        return;
      }

      if (query.ordered) {
        matched_before[qid] = query.matcher.documentMatches(doc).result;
      } else {
        // Because we don't support skip or limit (yet) in unordered queries, we
        // can just do a direct lookup.
        matched_before[qid] = query.results.has(doc._id);
      }
    });
    const old_doc = EJSON.clone(doc);

    LocalCollection._modify(doc, mod, {
      arrayIndices
    });

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        return;
      }

      const afterMatch = query.matcher.documentMatches(doc);
      const after = afterMatch.result;
      const before = matched_before[qid];

      if (after && query.distances && afterMatch.distance !== undefined) {
        query.distances.set(doc._id, afterMatch.distance);
      }

      if (query.cursor.skip || query.cursor.limit) {
        // We need to recompute any query where the doc may have been in the
        // cursor's window either before or after the update. (Note that if skip
        // or limit is set, "before" and "after" being true do not necessarily
        // mean that the document is in the cursor's output after skip/limit is
        // applied... but if they are false, then the document definitely is NOT
        // in the output. So it's safe to skip recompute if neither before or
        // after are true.)
        if (before || after) {
          recomputeQids[qid] = true;
        }
      } else if (before && !after) {
        LocalCollection._removeFromResults(query, doc);
      } else if (!before && after) {
        LocalCollection._insertInResults(query, doc);
      } else if (before && after) {
        LocalCollection._updateInResults(query, doc, old_doc);
      }
    });
  } // Recomputes the results of a query and runs observe callbacks for the
  // difference between the previous results and the current results (unless
  // paused). Used for skip/limit queries.
  //
  // When this is used by insert or remove, it can just use query.results for
  // the old results (and there's no need to pass in oldResults), because these
  // operations don't mutate the documents in the collection. Update needs to
  // pass in an oldResults which was deep-copied before the modifier was
  // applied.
  //
  // oldResults is guaranteed to be ignored if the query is not paused.


  _recomputeResults(query, oldResults) {
    if (this.paused) {
      // There's no reason to recompute the results now as we're still paused.
      // By flagging the query as "dirty", the recompute will be performed
      // when resumeObservers is called.
      query.dirty = true;
      return;
    }

    if (!this.paused && !oldResults) {
      oldResults = query.results;
    }

    if (query.distances) {
      query.distances.clear();
    }

    query.results = query.cursor._getRawObjects({
      distances: query.distances,
      ordered: query.ordered
    });

    if (!this.paused) {
      LocalCollection._diffQueryChanges(query.ordered, oldResults, query.results, query, {
        projectionFn: query.projectionFn
      });
    }
  }

  _saveOriginal(id, doc) {
    // Are we even trying to save originals?
    if (!this._savedOriginals) {
      return;
    } // Have we previously mutated the original (and so 'doc' is not actually
    // original)?  (Note the 'has' check rather than truth: we store undefined
    // here for inserted docs!)


    if (this._savedOriginals.has(id)) {
      return;
    }

    this._savedOriginals.set(id, EJSON.clone(doc));
  }

}

LocalCollection.Cursor = Cursor;
LocalCollection.ObserveHandle = ObserveHandle; // XXX maybe move these into another ObserveHelpers package or something
// _CachingChangeObserver is an object which receives observeChanges callbacks
// and keeps a cache of the current cursor state up to date in this.docs. Users
// of this class should read the docs field but not modify it. You should pass
// the "applyChange" field as the callbacks to the underlying observeChanges
// call. Optionally, you can specify your own observeChanges callbacks which are
// invoked immediately before the docs field is updated; this object is made
// available as `this` to those callbacks.

LocalCollection._CachingChangeObserver = class _CachingChangeObserver {
  constructor() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    const orderedFromCallbacks = options.callbacks && LocalCollection._observeChangesCallbacksAreOrdered(options.callbacks);

    if (hasOwn.call(options, 'ordered')) {
      this.ordered = options.ordered;

      if (options.callbacks && options.ordered !== orderedFromCallbacks) {
        throw Error('ordered option doesn\'t match callbacks');
      }
    } else if (options.callbacks) {
      this.ordered = orderedFromCallbacks;
    } else {
      throw Error('must provide ordered or callbacks');
    }

    const callbacks = options.callbacks || {};

    if (this.ordered) {
      this.docs = new OrderedDict(MongoID.idStringify);
      this.applyChange = {
        addedBefore: (id, fields, before) => {
          // Take a shallow copy since the top-level properties can be changed
          const doc = _objectSpread({}, fields);

          doc._id = id;

          if (callbacks.addedBefore) {
            callbacks.addedBefore.call(this, id, EJSON.clone(fields), before);
          } // This line triggers if we provide added with movedBefore.


          if (callbacks.added) {
            callbacks.added.call(this, id, EJSON.clone(fields));
          } // XXX could `before` be a falsy ID?  Technically
          // idStringify seems to allow for them -- though
          // OrderedDict won't call stringify on a falsy arg.


          this.docs.putBefore(id, doc, before || null);
        },
        movedBefore: (id, before) => {
          const doc = this.docs.get(id);

          if (callbacks.movedBefore) {
            callbacks.movedBefore.call(this, id, before);
          }

          this.docs.moveBefore(id, before || null);
        }
      };
    } else {
      this.docs = new LocalCollection._IdMap();
      this.applyChange = {
        added: (id, fields) => {
          // Take a shallow copy since the top-level properties can be changed
          const doc = _objectSpread({}, fields);

          if (callbacks.added) {
            callbacks.added.call(this, id, EJSON.clone(fields));
          }

          doc._id = id;
          this.docs.set(id, doc);
        }
      };
    } // The methods in _IdMap and OrderedDict used by these callbacks are
    // identical.


    this.applyChange.changed = (id, fields) => {
      const doc = this.docs.get(id);

      if (!doc) {
        throw new Error("Unknown id for changed: ".concat(id));
      }

      if (callbacks.changed) {
        callbacks.changed.call(this, id, EJSON.clone(fields));
      }

      DiffSequence.applyChanges(doc, fields);
    };

    this.applyChange.removed = id => {
      if (callbacks.removed) {
        callbacks.removed.call(this, id);
      }

      this.docs.remove(id);
    };
  }

};
LocalCollection._IdMap = class _IdMap extends IdMap {
  constructor() {
    super(MongoID.idStringify, MongoID.idParse);
  }

}; // Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.

LocalCollection.wrapTransform = transform => {
  if (!transform) {
    return null;
  } // No need to doubly-wrap transforms.


  if (transform.__wrappedTransform__) {
    return transform;
  }

  const wrapped = doc => {
    if (!hasOwn.call(doc, '_id')) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error('can only transform documents with _id');
    }

    const id = doc._id; // XXX consider making tracker a weak dependency and checking
    // Package.tracker here

    const transformed = Tracker.nonreactive(() => transform(doc));

    if (!LocalCollection._isPlainObject(transformed)) {
      throw new Error('transform must return object');
    }

    if (hasOwn.call(transformed, '_id')) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error('transformed document can\'t have different _id');
      }
    } else {
      transformed._id = id;
    }

    return transformed;
  };

  wrapped.__wrappedTransform__ = true;
  return wrapped;
}; // XXX the sorted-query logic below is laughably inefficient. we'll
// need to come up with a better datastructure for this.
//
// XXX the logic for observing with a skip or a limit is even more
// laughably inefficient. we recompute the whole results every time!
// This binary search puts a value between any equal values, and the first
// lesser value.


LocalCollection._binarySearch = (cmp, array, value) => {
  let first = 0;
  let range = array.length;

  while (range > 0) {
    const halfRange = Math.floor(range / 2);

    if (cmp(value, array[first + halfRange]) >= 0) {
      first += halfRange + 1;
      range -= halfRange + 1;
    } else {
      range = halfRange;
    }
  }

  return first;
};

LocalCollection._checkSupportedProjection = fields => {
  if (fields !== Object(fields) || Array.isArray(fields)) {
    throw MinimongoError('fields option must be an object');
  }

  Object.keys(fields).forEach(keyPath => {
    if (keyPath.split('.').includes('$')) {
      throw MinimongoError('Minimongo doesn\'t support $ operator in projections yet.');
    }

    const value = fields[keyPath];

    if (typeof value === 'object' && ['$elemMatch', '$meta', '$slice'].some(key => hasOwn.call(value, key))) {
      throw MinimongoError('Minimongo doesn\'t support operators in projections yet.');
    }

    if (![1, 0, true, false].includes(value)) {
      throw MinimongoError('Projection values should be one of 1, 0, true, or false');
    }
  });
}; // Knows how to compile a fields projection to a predicate function.
// @returns - Function: a closure that filters out an object according to the
//            fields projection rules:
//            @param obj - Object: MongoDB-styled document
//            @returns - Object: a document with the fields filtered out
//                       according to projection rules. Doesn't retain subfields
//                       of passed argument.


LocalCollection._compileProjection = fields => {
  LocalCollection._checkSupportedProjection(fields);

  const _idProjection = fields._id === undefined ? true : fields._id;

  const details = projectionDetails(fields); // returns transformed doc according to ruleTree

  const transform = (doc, ruleTree) => {
    // Special case for "sets"
    if (Array.isArray(doc)) {
      return doc.map(subdoc => transform(subdoc, ruleTree));
    }

    const result = details.including ? {} : EJSON.clone(doc);
    Object.keys(ruleTree).forEach(key => {
      if (doc == null || !hasOwn.call(doc, key)) {
        return;
      }

      const rule = ruleTree[key];

      if (rule === Object(rule)) {
        // For sub-objects/subsets we branch
        if (doc[key] === Object(doc[key])) {
          result[key] = transform(doc[key], rule);
        }
      } else if (details.including) {
        // Otherwise we don't even touch this subfield
        result[key] = EJSON.clone(doc[key]);
      } else {
        delete result[key];
      }
    });
    return doc != null ? result : doc;
  };

  return doc => {
    const result = transform(doc, details.tree);

    if (_idProjection && hasOwn.call(doc, '_id')) {
      result._id = doc._id;
    }

    if (!_idProjection && hasOwn.call(result, '_id')) {
      delete result._id;
    }

    return result;
  };
}; // Calculates the document to insert in case we're doing an upsert and the
// selector does not match any elements


LocalCollection._createUpsertDocument = (selector, modifier) => {
  const selectorDocument = populateDocumentWithQueryFields(selector);

  const isModify = LocalCollection._isModificationMod(modifier);

  const newDoc = {};

  if (selectorDocument._id) {
    newDoc._id = selectorDocument._id;
    delete selectorDocument._id;
  } // This double _modify call is made to help with nested properties (see issue
  // #8631). We do this even if it's a replacement for validation purposes (e.g.
  // ambiguous id's)


  LocalCollection._modify(newDoc, {
    $set: selectorDocument
  });

  LocalCollection._modify(newDoc, modifier, {
    isInsert: true
  });

  if (isModify) {
    return newDoc;
  } // Replacement can take _id from query document


  const replacement = Object.assign({}, modifier);

  if (newDoc._id) {
    replacement._id = newDoc._id;
  }

  return replacement;
};

LocalCollection._diffObjects = (left, right, callbacks) => {
  return DiffSequence.diffObjects(left, right, callbacks);
}; // ordered: bool.
// old_results and new_results: collections of documents.
//    if ordered, they are arrays.
//    if unordered, they are IdMaps


LocalCollection._diffQueryChanges = (ordered, oldResults, newResults, observer, options) => DiffSequence.diffQueryChanges(ordered, oldResults, newResults, observer, options);

LocalCollection._diffQueryOrderedChanges = (oldResults, newResults, observer, options) => DiffSequence.diffQueryOrderedChanges(oldResults, newResults, observer, options);

LocalCollection._diffQueryUnorderedChanges = (oldResults, newResults, observer, options) => DiffSequence.diffQueryUnorderedChanges(oldResults, newResults, observer, options);

LocalCollection._findInOrderedResults = (query, doc) => {
  if (!query.ordered) {
    throw new Error('Can\'t call _findInOrderedResults on unordered query');
  }

  for (let i = 0; i < query.results.length; i++) {
    if (query.results[i] === doc) {
      return i;
    }
  }

  throw Error('object missing from query');
}; // If this is a selector which explicitly constrains the match by ID to a finite
// number of documents, returns a list of their IDs.  Otherwise returns
// null. Note that the selector may have other restrictions so it may not even
// match those document!  We care about $in and $and since those are generated
// access-controlled update and remove.


LocalCollection._idsMatchedBySelector = selector => {
  // Is the selector just an ID?
  if (LocalCollection._selectorIsId(selector)) {
    return [selector];
  }

  if (!selector) {
    return null;
  } // Do we have an _id clause?


  if (hasOwn.call(selector, '_id')) {
    // Is the _id clause just an ID?
    if (LocalCollection._selectorIsId(selector._id)) {
      return [selector._id];
    } // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?


    if (selector._id && Array.isArray(selector._id.$in) && selector._id.$in.length && selector._id.$in.every(LocalCollection._selectorIsId)) {
      return selector._id.$in;
    }

    return null;
  } // If this is a top-level $and, and any of the clauses constrain their
  // documents, then the whole selector is constrained by any one clause's
  // constraint. (Well, by their intersection, but that seems unlikely.)


  if (Array.isArray(selector.$and)) {
    for (let i = 0; i < selector.$and.length; ++i) {
      const subIds = LocalCollection._idsMatchedBySelector(selector.$and[i]);

      if (subIds) {
        return subIds;
      }
    }
  }

  return null;
};

LocalCollection._insertInResults = (query, doc) => {
  const fields = EJSON.clone(doc);
  delete fields._id;

  if (query.ordered) {
    if (!query.sorter) {
      query.addedBefore(doc._id, query.projectionFn(fields), null);
      query.results.push(doc);
    } else {
      const i = LocalCollection._insertInSortedList(query.sorter.getComparator({
        distances: query.distances
      }), query.results, doc);

      let next = query.results[i + 1];

      if (next) {
        next = next._id;
      } else {
        next = null;
      }

      query.addedBefore(doc._id, query.projectionFn(fields), next);
    }

    query.added(doc._id, query.projectionFn(fields));
  } else {
    query.added(doc._id, query.projectionFn(fields));
    query.results.set(doc._id, doc);
  }
};

LocalCollection._insertInSortedList = (cmp, array, value) => {
  if (array.length === 0) {
    array.push(value);
    return 0;
  }

  const i = LocalCollection._binarySearch(cmp, array, value);

  array.splice(i, 0, value);
  return i;
};

LocalCollection._isModificationMod = mod => {
  let isModify = false;
  let isReplace = false;
  Object.keys(mod).forEach(key => {
    if (key.substr(0, 1) === '$') {
      isModify = true;
    } else {
      isReplace = true;
    }
  });

  if (isModify && isReplace) {
    throw new Error('Update parameter cannot have both modifier and non-modifier fields.');
  }

  return isModify;
}; // XXX maybe this should be EJSON.isObject, though EJSON doesn't know about
// RegExp
// XXX note that _type(undefined) === 3!!!!


LocalCollection._isPlainObject = x => {
  return x && LocalCollection._f._type(x) === 3;
}; // XXX need a strategy for passing the binding of $ into this
// function, from the compiled selector
//
// maybe just {key.up.to.just.before.dollarsign: array_index}
//
// XXX atomicity: if one modification fails, do we roll back the whole
// change?
//
// options:
//   - isInsert is set when _modify is being called to compute the document to
//     insert as part of an upsert operation. We use this primarily to figure
//     out when to set the fields in $setOnInsert, if present.


LocalCollection._modify = function (doc, modifier) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

  if (!LocalCollection._isPlainObject(modifier)) {
    throw MinimongoError('Modifier must be an object');
  } // Make sure the caller can't mutate our data structures.


  modifier = EJSON.clone(modifier);
  const isModifier = isOperatorObject(modifier);
  const newDoc = isModifier ? EJSON.clone(doc) : modifier;

  if (isModifier) {
    // apply modifiers to the doc.
    Object.keys(modifier).forEach(operator => {
      // Treat $setOnInsert as $set if this is an insert.
      const setOnInsert = options.isInsert && operator === '$setOnInsert';
      const modFunc = MODIFIERS[setOnInsert ? '$set' : operator];
      const operand = modifier[operator];

      if (!modFunc) {
        throw MinimongoError("Invalid modifier specified ".concat(operator));
      }

      Object.keys(operand).forEach(keypath => {
        const arg = operand[keypath];

        if (keypath === '') {
          throw MinimongoError('An empty update path is not valid.');
        }

        const keyparts = keypath.split('.');

        if (!keyparts.every(Boolean)) {
          throw MinimongoError("The update path '".concat(keypath, "' contains an empty field name, ") + 'which is not allowed.');
        }

        const target = findModTarget(newDoc, keyparts, {
          arrayIndices: options.arrayIndices,
          forbidArray: operator === '$rename',
          noCreate: NO_CREATE_MODIFIERS[operator]
        });
        modFunc(target, keyparts.pop(), arg, keypath, newDoc);
      });
    });

    if (doc._id && !EJSON.equals(doc._id, newDoc._id)) {
      throw MinimongoError("After applying the update to the document {_id: \"".concat(doc._id, "\", ...},") + ' the (immutable) field \'_id\' was found to have been altered to ' + "_id: \"".concat(newDoc._id, "\""));
    }
  } else {
    if (doc._id && modifier._id && !EJSON.equals(doc._id, modifier._id)) {
      throw MinimongoError("The _id field cannot be changed from {_id: \"".concat(doc._id, "\"} to ") + "{_id: \"".concat(modifier._id, "\"}"));
    } // replace the whole document


    assertHasValidFieldNames(modifier);
  } // move new document into place.


  Object.keys(doc).forEach(key => {
    // Note: this used to be for (var key in doc) however, this does not
    // work right in Opera. Deleting from a doc while iterating over it
    // would sometimes cause opera to skip some keys.
    if (key !== '_id') {
      delete doc[key];
    }
  });
  Object.keys(newDoc).forEach(key => {
    doc[key] = newDoc[key];
  });
};

LocalCollection._observeFromObserveChanges = (cursor, observeCallbacks) => {
  const transform = cursor.getTransform() || (doc => doc);

  let suppressed = !!observeCallbacks._suppress_initial;
  let observeChangesCallbacks;

  if (LocalCollection._observeCallbacksAreOrdered(observeCallbacks)) {
    // The "_no_indices" option sets all index arguments to -1 and skips the
    // linear scans required to generate them.  This lets observers that don't
    // need absolute indices benefit from the other features of this API --
    // relative order, transforms, and applyChanges -- without the speed hit.
    const indices = !observeCallbacks._no_indices;
    observeChangesCallbacks = {
      addedBefore(id, fields, before) {
        if (suppressed || !(observeCallbacks.addedAt || observeCallbacks.added)) {
          return;
        }

        const doc = transform(Object.assign(fields, {
          _id: id
        }));

        if (observeCallbacks.addedAt) {
          observeCallbacks.addedAt(doc, indices ? before ? this.docs.indexOf(before) : this.docs.size() : -1, before);
        } else {
          observeCallbacks.added(doc);
        }
      },

      changed(id, fields) {
        if (!(observeCallbacks.changedAt || observeCallbacks.changed)) {
          return;
        }

        let doc = EJSON.clone(this.docs.get(id));

        if (!doc) {
          throw new Error("Unknown id for changed: ".concat(id));
        }

        const oldDoc = transform(EJSON.clone(doc));
        DiffSequence.applyChanges(doc, fields);

        if (observeCallbacks.changedAt) {
          observeCallbacks.changedAt(transform(doc), oldDoc, indices ? this.docs.indexOf(id) : -1);
        } else {
          observeCallbacks.changed(transform(doc), oldDoc);
        }
      },

      movedBefore(id, before) {
        if (!observeCallbacks.movedTo) {
          return;
        }

        const from = indices ? this.docs.indexOf(id) : -1;
        let to = indices ? before ? this.docs.indexOf(before) : this.docs.size() : -1; // When not moving backwards, adjust for the fact that removing the
        // document slides everything back one slot.

        if (to > from) {
          --to;
        }

        observeCallbacks.movedTo(transform(EJSON.clone(this.docs.get(id))), from, to, before || null);
      },

      removed(id) {
        if (!(observeCallbacks.removedAt || observeCallbacks.removed)) {
          return;
        } // technically maybe there should be an EJSON.clone here, but it's about
        // to be removed from this.docs!


        const doc = transform(this.docs.get(id));

        if (observeCallbacks.removedAt) {
          observeCallbacks.removedAt(doc, indices ? this.docs.indexOf(id) : -1);
        } else {
          observeCallbacks.removed(doc);
        }
      }

    };
  } else {
    observeChangesCallbacks = {
      added(id, fields) {
        if (!suppressed && observeCallbacks.added) {
          observeCallbacks.added(transform(Object.assign(fields, {
            _id: id
          })));
        }
      },

      changed(id, fields) {
        if (observeCallbacks.changed) {
          const oldDoc = this.docs.get(id);
          const doc = EJSON.clone(oldDoc);
          DiffSequence.applyChanges(doc, fields);
          observeCallbacks.changed(transform(doc), transform(EJSON.clone(oldDoc)));
        }
      },

      removed(id) {
        if (observeCallbacks.removed) {
          observeCallbacks.removed(transform(this.docs.get(id)));
        }
      }

    };
  }

  const changeObserver = new LocalCollection._CachingChangeObserver({
    callbacks: observeChangesCallbacks
  }); // CachingChangeObserver clones all received input on its callbacks
  // So we can mark it as safe to reduce the ejson clones.
  // This is tested by the `mongo-livedata - (extended) scribbling` tests

  changeObserver.applyChange._fromObserve = true;
  const handle = cursor.observeChanges(changeObserver.applyChange, {
    nonMutatingCallbacks: true
  });
  suppressed = false;
  return handle;
};

LocalCollection._observeCallbacksAreOrdered = callbacks => {
  if (callbacks.added && callbacks.addedAt) {
    throw new Error('Please specify only one of added() and addedAt()');
  }

  if (callbacks.changed && callbacks.changedAt) {
    throw new Error('Please specify only one of changed() and changedAt()');
  }

  if (callbacks.removed && callbacks.removedAt) {
    throw new Error('Please specify only one of removed() and removedAt()');
  }

  return !!(callbacks.addedAt || callbacks.changedAt || callbacks.movedTo || callbacks.removedAt);
};

LocalCollection._observeChangesCallbacksAreOrdered = callbacks => {
  if (callbacks.added && callbacks.addedBefore) {
    throw new Error('Please specify only one of added() and addedBefore()');
  }

  return !!(callbacks.addedBefore || callbacks.movedBefore);
};

LocalCollection._removeFromResults = (query, doc) => {
  if (query.ordered) {
    const i = LocalCollection._findInOrderedResults(query, doc);

    query.removed(doc._id);
    query.results.splice(i, 1);
  } else {
    const id = doc._id; // in case callback mutates doc

    query.removed(doc._id);
    query.results.remove(id);
  }
}; // Is this selector just shorthand for lookup by _id?


LocalCollection._selectorIsId = selector => typeof selector === 'number' || typeof selector === 'string' || selector instanceof MongoID.ObjectID; // Is the selector just lookup by _id (shorthand or not)?


LocalCollection._selectorIsIdPerhapsAsObject = selector => LocalCollection._selectorIsId(selector) || LocalCollection._selectorIsId(selector && selector._id) && Object.keys(selector).length === 1;

LocalCollection._updateInResults = (query, doc, old_doc) => {
  if (!EJSON.equals(doc._id, old_doc._id)) {
    throw new Error('Can\'t change a doc\'s _id while updating');
  }

  const projectionFn = query.projectionFn;
  const changedFields = DiffSequence.makeChangedFields(projectionFn(doc), projectionFn(old_doc));

  if (!query.ordered) {
    if (Object.keys(changedFields).length) {
      query.changed(doc._id, changedFields);
      query.results.set(doc._id, doc);
    }

    return;
  }

  const old_idx = LocalCollection._findInOrderedResults(query, doc);

  if (Object.keys(changedFields).length) {
    query.changed(doc._id, changedFields);
  }

  if (!query.sorter) {
    return;
  } // just take it out and put it back in again, and see if the index changes


  query.results.splice(old_idx, 1);

  const new_idx = LocalCollection._insertInSortedList(query.sorter.getComparator({
    distances: query.distances
  }), query.results, doc);

  if (old_idx !== new_idx) {
    let next = query.results[new_idx + 1];

    if (next) {
      next = next._id;
    } else {
      next = null;
    }

    query.movedBefore && query.movedBefore(doc._id, next);
  }
};

const MODIFIERS = {
  $currentDate(target, field, arg) {
    if (typeof arg === 'object' && hasOwn.call(arg, '$type')) {
      if (arg.$type !== 'date') {
        throw MinimongoError('Minimongo does currently only support the date type in ' + '$currentDate modifiers', {
          field
        });
      }
    } else if (arg !== true) {
      throw MinimongoError('Invalid $currentDate modifier', {
        field
      });
    }

    target[field] = new Date();
  },

  $inc(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $inc allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $inc modifier to non-number', {
          field
        });
      }

      target[field] += arg;
    } else {
      target[field] = arg;
    }
  },

  $min(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $min allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $min modifier to non-number', {
          field
        });
      }

      if (target[field] > arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },

  $max(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $max allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $max modifier to non-number', {
          field
        });
      }

      if (target[field] < arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },

  $mul(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $mul allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $mul modifier to non-number', {
          field
        });
      }

      target[field] *= arg;
    } else {
      target[field] = 0;
    }
  },

  $rename(target, field, arg, keypath, doc) {
    // no idea why mongo has this restriction..
    if (keypath === arg) {
      throw MinimongoError('$rename source must differ from target', {
        field
      });
    }

    if (target === null) {
      throw MinimongoError('$rename source field invalid', {
        field
      });
    }

    if (typeof arg !== 'string') {
      throw MinimongoError('$rename target must be a string', {
        field
      });
    }

    if (arg.includes('\0')) {
      // Null bytes are not allowed in Mongo field names
      // https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names
      throw MinimongoError('The \'to\' field for $rename cannot contain an embedded null byte', {
        field
      });
    }

    if (target === undefined) {
      return;
    }

    const object = target[field];
    delete target[field];
    const keyparts = arg.split('.');
    const target2 = findModTarget(doc, keyparts, {
      forbidArray: true
    });

    if (target2 === null) {
      throw MinimongoError('$rename target field invalid', {
        field
      });
    }

    target2[keyparts.pop()] = object;
  },

  $set(target, field, arg) {
    if (target !== Object(target)) {
      // not an array or an object
      const error = MinimongoError('Cannot set property on non-object field', {
        field
      });
      error.setPropertyError = true;
      throw error;
    }

    if (target === null) {
      const error = MinimongoError('Cannot set property on null', {
        field
      });
      error.setPropertyError = true;
      throw error;
    }

    assertHasValidFieldNames(arg);
    target[field] = arg;
  },

  $setOnInsert(target, field, arg) {// converted to `$set` in `_modify`
  },

  $unset(target, field, arg) {
    if (target !== undefined) {
      if (target instanceof Array) {
        if (field in target) {
          target[field] = null;
        }
      } else {
        delete target[field];
      }
    }
  },

  $push(target, field, arg) {
    if (target[field] === undefined) {
      target[field] = [];
    }

    if (!(target[field] instanceof Array)) {
      throw MinimongoError('Cannot apply $push modifier to non-array', {
        field
      });
    }

    if (!(arg && arg.$each)) {
      // Simple mode: not $each
      assertHasValidFieldNames(arg);
      target[field].push(arg);
      return;
    } // Fancy mode: $each (and maybe $slice and $sort and $position)


    const toPush = arg.$each;

    if (!(toPush instanceof Array)) {
      throw MinimongoError('$each must be an array', {
        field
      });
    }

    assertHasValidFieldNames(toPush); // Parse $position

    let position = undefined;

    if ('$position' in arg) {
      if (typeof arg.$position !== 'number') {
        throw MinimongoError('$position must be a numeric value', {
          field
        });
      } // XXX should check to make sure integer


      if (arg.$position < 0) {
        throw MinimongoError('$position in $push must be zero or positive', {
          field
        });
      }

      position = arg.$position;
    } // Parse $slice.


    let slice = undefined;

    if ('$slice' in arg) {
      if (typeof arg.$slice !== 'number') {
        throw MinimongoError('$slice must be a numeric value', {
          field
        });
      } // XXX should check to make sure integer


      slice = arg.$slice;
    } // Parse $sort.


    let sortFunction = undefined;

    if (arg.$sort) {
      if (slice === undefined) {
        throw MinimongoError('$sort requires $slice to be present', {
          field
        });
      } // XXX this allows us to use a $sort whose value is an array, but that's
      // actually an extension of the Node driver, so it won't work
      // server-side. Could be confusing!
      // XXX is it correct that we don't do geo-stuff here?


      sortFunction = new Minimongo.Sorter(arg.$sort).getComparator();
      toPush.forEach(element => {
        if (LocalCollection._f._type(element) !== 3) {
          throw MinimongoError('$push like modifiers using $sort require all elements to be ' + 'objects', {
            field
          });
        }
      });
    } // Actually push.


    if (position === undefined) {
      toPush.forEach(element => {
        target[field].push(element);
      });
    } else {
      const spliceArguments = [position, 0];
      toPush.forEach(element => {
        spliceArguments.push(element);
      });
      target[field].splice(...spliceArguments);
    } // Actually sort.


    if (sortFunction) {
      target[field].sort(sortFunction);
    } // Actually slice.


    if (slice !== undefined) {
      if (slice === 0) {
        target[field] = []; // differs from Array.slice!
      } else if (slice < 0) {
        target[field] = target[field].slice(slice);
      } else {
        target[field] = target[field].slice(0, slice);
      }
    }
  },

  $pushAll(target, field, arg) {
    if (!(typeof arg === 'object' && arg instanceof Array)) {
      throw MinimongoError('Modifier $pushAll/pullAll allowed for arrays only');
    }

    assertHasValidFieldNames(arg);
    const toPush = target[field];

    if (toPush === undefined) {
      target[field] = arg;
    } else if (!(toPush instanceof Array)) {
      throw MinimongoError('Cannot apply $pushAll modifier to non-array', {
        field
      });
    } else {
      toPush.push(...arg);
    }
  },

  $addToSet(target, field, arg) {
    let isEach = false;

    if (typeof arg === 'object') {
      // check if first key is '$each'
      const keys = Object.keys(arg);

      if (keys[0] === '$each') {
        isEach = true;
      }
    }

    const values = isEach ? arg.$each : [arg];
    assertHasValidFieldNames(values);
    const toAdd = target[field];

    if (toAdd === undefined) {
      target[field] = values;
    } else if (!(toAdd instanceof Array)) {
      throw MinimongoError('Cannot apply $addToSet modifier to non-array', {
        field
      });
    } else {
      values.forEach(value => {
        if (toAdd.some(element => LocalCollection._f._equal(value, element))) {
          return;
        }

        toAdd.push(value);
      });
    }
  },

  $pop(target, field, arg) {
    if (target === undefined) {
      return;
    }

    const toPop = target[field];

    if (toPop === undefined) {
      return;
    }

    if (!(toPop instanceof Array)) {
      throw MinimongoError('Cannot apply $pop modifier to non-array', {
        field
      });
    }

    if (typeof arg === 'number' && arg < 0) {
      toPop.splice(0, 1);
    } else {
      toPop.pop();
    }
  },

  $pull(target, field, arg) {
    if (target === undefined) {
      return;
    }

    const toPull = target[field];

    if (toPull === undefined) {
      return;
    }

    if (!(toPull instanceof Array)) {
      throw MinimongoError('Cannot apply $pull/pullAll modifier to non-array', {
        field
      });
    }

    let out;

    if (arg != null && typeof arg === 'object' && !(arg instanceof Array)) {
      // XXX would be much nicer to compile this once, rather than
      // for each document we modify.. but usually we're not
      // modifying that many documents, so we'll let it slide for
      // now
      // XXX Minimongo.Matcher isn't up for the job, because we need
      // to permit stuff like {$pull: {a: {$gt: 4}}}.. something
      // like {$gt: 4} is not normally a complete selector.
      // same issue as $elemMatch possibly?
      const matcher = new Minimongo.Matcher(arg);
      out = toPull.filter(element => !matcher.documentMatches(element).result);
    } else {
      out = toPull.filter(element => !LocalCollection._f._equal(element, arg));
    }

    target[field] = out;
  },

  $pullAll(target, field, arg) {
    if (!(typeof arg === 'object' && arg instanceof Array)) {
      throw MinimongoError('Modifier $pushAll/pullAll allowed for arrays only', {
        field
      });
    }

    if (target === undefined) {
      return;
    }

    const toPull = target[field];

    if (toPull === undefined) {
      return;
    }

    if (!(toPull instanceof Array)) {
      throw MinimongoError('Cannot apply $pull/pullAll modifier to non-array', {
        field
      });
    }

    target[field] = toPull.filter(object => !arg.some(element => LocalCollection._f._equal(object, element)));
  },

  $bit(target, field, arg) {
    // XXX mongo only supports $bit on integers, and we only support
    // native javascript numbers (doubles) so far, so we can't support $bit
    throw MinimongoError('$bit is not supported', {
      field
    });
  },

  $v() {// As discussed in https://github.com/meteor/meteor/issues/9623,
    // the `$v` operator is not needed by Meteor, but problems can occur if
    // it's not at least callable (as of Mongo >= 3.6). It's defined here as
    // a no-op to work around these problems.
  }

};
const NO_CREATE_MODIFIERS = {
  $pop: true,
  $pull: true,
  $pullAll: true,
  $rename: true,
  $unset: true
}; // Make sure field names do not contain Mongo restricted
// characters ('.', '$', '\0').
// https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names

const invalidCharMsg = {
  $: 'start with \'$\'',
  '.': 'contain \'.\'',
  '\0': 'contain null bytes'
}; // checks if all field names in an object are valid

function assertHasValidFieldNames(doc) {
  if (doc && typeof doc === 'object') {
    JSON.stringify(doc, (key, value) => {
      assertIsValidFieldName(key);
      return value;
    });
  }
}

function assertIsValidFieldName(key) {
  let match;

  if (typeof key === 'string' && (match = key.match(/^\$|\.|\0/))) {
    throw MinimongoError("Key ".concat(key, " must not ").concat(invalidCharMsg[match[0]]));
  }
} // for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],
// and then you would operate on the 'e' property of the returned
// object.
//
// if options.noCreate is falsey, creates intermediate levels of
// structure as necessary, like mkdir -p (and raises an exception if
// that would mean giving a non-numeric property to an array.) if
// options.noCreate is true, return undefined instead.
//
// may modify the last element of keyparts to signal to the caller that it needs
// to use a different value to index into the returned object (for example,
// ['a', '01'] -> ['a', 1]).
//
// if forbidArray is true, return null if the keypath goes through an array.
//
// if options.arrayIndices is set, use its first element for the (first) '$' in
// the path.


function findModTarget(doc, keyparts) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  let usedArrayIndex = false;

  for (let i = 0; i < keyparts.length; i++) {
    const last = i === keyparts.length - 1;
    let keypart = keyparts[i];

    if (!isIndexable(doc)) {
      if (options.noCreate) {
        return undefined;
      }

      const error = MinimongoError("cannot use the part '".concat(keypart, "' to traverse ").concat(doc));
      error.setPropertyError = true;
      throw error;
    }

    if (doc instanceof Array) {
      if (options.forbidArray) {
        return null;
      }

      if (keypart === '$') {
        if (usedArrayIndex) {
          throw MinimongoError('Too many positional (i.e. \'$\') elements');
        }

        if (!options.arrayIndices || !options.arrayIndices.length) {
          throw MinimongoError('The positional operator did not find the match needed from the ' + 'query');
        }

        keypart = options.arrayIndices[0];
        usedArrayIndex = true;
      } else if (isNumericKey(keypart)) {
        keypart = parseInt(keypart);
      } else {
        if (options.noCreate) {
          return undefined;
        }

        throw MinimongoError("can't append to array using string field name [".concat(keypart, "]"));
      }

      if (last) {
        keyparts[i] = keypart; // handle 'a.01'
      }

      if (options.noCreate && keypart >= doc.length) {
        return undefined;
      }

      while (doc.length < keypart) {
        doc.push(null);
      }

      if (!last) {
        if (doc.length === keypart) {
          doc.push({});
        } else if (typeof doc[keypart] !== 'object') {
          throw MinimongoError("can't modify field '".concat(keyparts[i + 1], "' of list value ") + JSON.stringify(doc[keypart]));
        }
      }
    } else {
      assertIsValidFieldName(keypart);

      if (!(keypart in doc)) {
        if (options.noCreate) {
          return undefined;
        }

        if (!last) {
          doc[keypart] = {};
        }
      }
    }

    if (last) {
      return doc;
    }

    doc = doc[keypart];
  } // notreached

}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"matcher.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/matcher.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var _Package$mongoDecima;

module.export({
  default: () => Matcher
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }

}, 0);
let compileDocumentSelector, hasOwn, nothingMatcher;
module.link("./common.js", {
  compileDocumentSelector(v) {
    compileDocumentSelector = v;
  },

  hasOwn(v) {
    hasOwn = v;
  },

  nothingMatcher(v) {
    nothingMatcher = v;
  }

}, 1);
const Decimal = ((_Package$mongoDecima = Package['mongo-decimal']) === null || _Package$mongoDecima === void 0 ? void 0 : _Package$mongoDecima.Decimal) || class DecimalStub {}; // The minimongo selector compiler!
// Terminology:
//  - a 'selector' is the EJSON object representing a selector
//  - a 'matcher' is its compiled form (whether a full Minimongo.Matcher
//    object or one of the component lambdas that matches parts of it)
//  - a 'result object' is an object with a 'result' field and maybe
//    distance and arrayIndices.
//  - a 'branched value' is an object with a 'value' field and maybe
//    'dontIterate' and 'arrayIndices'.
//  - a 'document' is a top-level object that can be stored in a collection.
//  - a 'lookup function' is a function that takes in a document and returns
//    an array of 'branched values'.
//  - a 'branched matcher' maps from an array of branched values to a result
//    object.
//  - an 'element matcher' maps from a single value to a bool.
// Main entry point.
//   var matcher = new Minimongo.Matcher({a: {$gt: 5}});
//   if (matcher.documentMatches({a: 7})) ...

class Matcher {
  constructor(selector, isUpdate) {
    // A set (object mapping string -> *) of all of the document paths looked
    // at by the selector. Also includes the empty string if it may look at any
    // path (eg, $where).
    this._paths = {}; // Set to true if compilation finds a $near.

    this._hasGeoQuery = false; // Set to true if compilation finds a $where.

    this._hasWhere = false; // Set to false if compilation finds anything other than a simple equality
    // or one or more of '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin' used
    // with scalars as operands.

    this._isSimple = true; // Set to a dummy document which always matches this Matcher. Or set to null
    // if such document is too hard to find.

    this._matchingDocument = undefined; // A clone of the original selector. It may just be a function if the user
    // passed in a function; otherwise is definitely an object (eg, IDs are
    // translated into {_id: ID} first. Used by canBecomeTrueByModifier and
    // Sorter._useWithMatcher.

    this._selector = null;
    this._docMatcher = this._compileSelector(selector); // Set to true if selection is done for an update operation
    // Default is false
    // Used for $near array update (issue #3599)

    this._isUpdate = isUpdate;
  }

  documentMatches(doc) {
    if (doc !== Object(doc)) {
      throw Error('documentMatches needs a document');
    }

    return this._docMatcher(doc);
  }

  hasGeoQuery() {
    return this._hasGeoQuery;
  }

  hasWhere() {
    return this._hasWhere;
  }

  isSimple() {
    return this._isSimple;
  } // Given a selector, return a function that takes one argument, a
  // document. It returns a result object.


  _compileSelector(selector) {
    // you can pass a literal function instead of a selector
    if (selector instanceof Function) {
      this._isSimple = false;
      this._selector = selector;

      this._recordPathUsed('');

      return doc => ({
        result: !!selector.call(doc)
      });
    } // shorthand -- scalar _id


    if (LocalCollection._selectorIsId(selector)) {
      this._selector = {
        _id: selector
      };

      this._recordPathUsed('_id');

      return doc => ({
        result: EJSON.equals(doc._id, selector)
      });
    } // protect against dangerous selectors.  falsey and {_id: falsey} are both
    // likely programmer error, and not what you want, particularly for
    // destructive operations.


    if (!selector || hasOwn.call(selector, '_id') && !selector._id) {
      this._isSimple = false;
      return nothingMatcher;
    } // Top level can't be an array or true or binary.


    if (Array.isArray(selector) || EJSON.isBinary(selector) || typeof selector === 'boolean') {
      throw new Error("Invalid selector: ".concat(selector));
    }

    this._selector = EJSON.clone(selector);
    return compileDocumentSelector(selector, this, {
      isRoot: true
    });
  } // Returns a list of key paths the given selector is looking for. It includes
  // the empty string if there is a $where.


  _getPaths() {
    return Object.keys(this._paths);
  }

  _recordPathUsed(path) {
    this._paths[path] = true;
  }

}

// helpers used by compiled selector code
LocalCollection._f = {
  // XXX for _all and _in, consider building 'inquery' at compile time..
  _type(v) {
    if (typeof v === 'number') {
      return 1;
    }

    if (typeof v === 'string') {
      return 2;
    }

    if (typeof v === 'boolean') {
      return 8;
    }

    if (Array.isArray(v)) {
      return 4;
    }

    if (v === null) {
      return 10;
    } // note that typeof(/x/) === "object"


    if (v instanceof RegExp) {
      return 11;
    }

    if (typeof v === 'function') {
      return 13;
    }

    if (v instanceof Date) {
      return 9;
    }

    if (EJSON.isBinary(v)) {
      return 5;
    }

    if (v instanceof MongoID.ObjectID) {
      return 7;
    }

    if (v instanceof Decimal) {
      return 1;
    } // object


    return 3; // XXX support some/all of these:
    // 14, symbol
    // 15, javascript code with scope
    // 16, 18: 32-bit/64-bit integer
    // 17, timestamp
    // 255, minkey
    // 127, maxkey
  },

  // deep equality test: use for literal document and array matches
  _equal(a, b) {
    return EJSON.equals(a, b, {
      keyOrderSensitive: true
    });
  },

  // maps a type code to a value that can be used to sort values of different
  // types
  _typeorder(t) {
    // http://www.mongodb.org/display/DOCS/What+is+the+Compare+Order+for+BSON+Types
    // XXX what is the correct sort position for Javascript code?
    // ('100' in the matrix below)
    // XXX minkey/maxkey
    return [-1, // (not a type)
    1, // number
    2, // string
    3, // object
    4, // array
    5, // binary
    -1, // deprecated
    6, // ObjectID
    7, // bool
    8, // Date
    0, // null
    9, // RegExp
    -1, // deprecated
    100, // JS code
    2, // deprecated (symbol)
    100, // JS code
    1, // 32-bit int
    8, // Mongo timestamp
    1 // 64-bit int
    ][t];
  },

  // compare two values of unknown type according to BSON ordering
  // semantics. (as an extension, consider 'undefined' to be less than
  // any other value.) return negative if a is less, positive if b is
  // less, or 0 if equal
  _cmp(a, b) {
    if (a === undefined) {
      return b === undefined ? 0 : -1;
    }

    if (b === undefined) {
      return 1;
    }

    let ta = LocalCollection._f._type(a);

    let tb = LocalCollection._f._type(b);

    const oa = LocalCollection._f._typeorder(ta);

    const ob = LocalCollection._f._typeorder(tb);

    if (oa !== ob) {
      return oa < ob ? -1 : 1;
    } // XXX need to implement this if we implement Symbol or integers, or
    // Timestamp


    if (ta !== tb) {
      throw Error('Missing type coercion logic in _cmp');
    }

    if (ta === 7) {
      // ObjectID
      // Convert to string.
      ta = tb = 2;
      a = a.toHexString();
      b = b.toHexString();
    }

    if (ta === 9) {
      // Date
      // Convert to millis.
      ta = tb = 1;
      a = a.getTime();
      b = b.getTime();
    }

    if (ta === 1) {
      // double
      if (a instanceof Decimal) {
        return a.minus(b).toNumber();
      } else {
        return a - b;
      }
    }

    if (tb === 2) // string
      return a < b ? -1 : a === b ? 0 : 1;

    if (ta === 3) {
      // Object
      // this could be much more efficient in the expected case ...
      const toArray = object => {
        const result = [];
        Object.keys(object).forEach(key => {
          result.push(key, object[key]);
        });
        return result;
      };

      return LocalCollection._f._cmp(toArray(a), toArray(b));
    }

    if (ta === 4) {
      // Array
      for (let i = 0;; i++) {
        if (i === a.length) {
          return i === b.length ? 0 : -1;
        }

        if (i === b.length) {
          return 1;
        }

        const s = LocalCollection._f._cmp(a[i], b[i]);

        if (s !== 0) {
          return s;
        }
      }
    }

    if (ta === 5) {
      // binary
      // Surprisingly, a small binary blob is always less than a large one in
      // Mongo.
      if (a.length !== b.length) {
        return a.length - b.length;
      }

      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) {
          return -1;
        }

        if (a[i] > b[i]) {
          return 1;
        }
      }

      return 0;
    }

    if (ta === 8) {
      // boolean
      if (a) {
        return b ? 0 : 1;
      }

      return b ? -1 : 0;
    }

    if (ta === 10) // null
      return 0;
    if (ta === 11) // regexp
      throw Error('Sorting not supported on regular expression'); // XXX
    // 13: javascript code
    // 14: symbol
    // 15: javascript code with scope
    // 16: 32-bit integer
    // 17: timestamp
    // 18: 64-bit integer
    // 255: minkey
    // 127: maxkey

    if (ta === 13) // javascript code
      throw Error('Sorting not supported on Javascript code'); // XXX

    throw Error('Unknown type to sort');
  }

};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"minimongo_common.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/minimongo_common.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let LocalCollection_;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection_ = v;
  }

}, 0);
let Matcher;
module.link("./matcher.js", {
  default(v) {
    Matcher = v;
  }

}, 1);
let Sorter;
module.link("./sorter.js", {
  default(v) {
    Sorter = v;
  }

}, 2);
LocalCollection = LocalCollection_;
Minimongo = {
  LocalCollection: LocalCollection_,
  Matcher,
  Sorter
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"observe_handle.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/observe_handle.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => ObserveHandle
});

class ObserveHandle {}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"sorter.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/sorter.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => Sorter
});
let ELEMENT_OPERATORS, equalityElementMatcher, expandArraysInBranches, hasOwn, isOperatorObject, makeLookupFunction, regexpElementMatcher;
module.link("./common.js", {
  ELEMENT_OPERATORS(v) {
    ELEMENT_OPERATORS = v;
  },

  equalityElementMatcher(v) {
    equalityElementMatcher = v;
  },

  expandArraysInBranches(v) {
    expandArraysInBranches = v;
  },

  hasOwn(v) {
    hasOwn = v;
  },

  isOperatorObject(v) {
    isOperatorObject = v;
  },

  makeLookupFunction(v) {
    makeLookupFunction = v;
  },

  regexpElementMatcher(v) {
    regexpElementMatcher = v;
  }

}, 0);

class Sorter {
  constructor(spec) {
    this._sortSpecParts = [];
    this._sortFunction = null;

    const addSpecPart = (path, ascending) => {
      if (!path) {
        throw Error('sort keys must be non-empty');
      }

      if (path.charAt(0) === '$') {
        throw Error("unsupported sort key: ".concat(path));
      }

      this._sortSpecParts.push({
        ascending,
        lookup: makeLookupFunction(path, {
          forSort: true
        }),
        path
      });
    };

    if (spec instanceof Array) {
      spec.forEach(element => {
        if (typeof element === 'string') {
          addSpecPart(element, true);
        } else {
          addSpecPart(element[0], element[1] !== 'desc');
        }
      });
    } else if (typeof spec === 'object') {
      Object.keys(spec).forEach(key => {
        addSpecPart(key, spec[key] >= 0);
      });
    } else if (typeof spec === 'function') {
      this._sortFunction = spec;
    } else {
      throw Error("Bad sort specification: ".concat(JSON.stringify(spec)));
    } // If a function is specified for sorting, we skip the rest.


    if (this._sortFunction) {
      return;
    } // To implement affectedByModifier, we piggy-back on top of Matcher's
    // affectedByModifier code; we create a selector that is affected by the
    // same modifiers as this sort order. This is only implemented on the
    // server.


    if (this.affectedByModifier) {
      const selector = {};

      this._sortSpecParts.forEach(spec => {
        selector[spec.path] = 1;
      });

      this._selectorForAffectedByModifier = new Minimongo.Matcher(selector);
    }

    this._keyComparator = composeComparators(this._sortSpecParts.map((spec, i) => this._keyFieldComparator(i)));
  }

  getComparator(options) {
    // If sort is specified or have no distances, just use the comparator from
    // the source specification (which defaults to "everything is equal".
    // issue #3599
    // https://docs.mongodb.com/manual/reference/operator/query/near/#sort-operation
    // sort effectively overrides $near
    if (this._sortSpecParts.length || !options || !options.distances) {
      return this._getBaseComparator();
    }

    const distances = options.distances; // Return a comparator which compares using $near distances.

    return (a, b) => {
      if (!distances.has(a._id)) {
        throw Error("Missing distance for ".concat(a._id));
      }

      if (!distances.has(b._id)) {
        throw Error("Missing distance for ".concat(b._id));
      }

      return distances.get(a._id) - distances.get(b._id);
    };
  } // Takes in two keys: arrays whose lengths match the number of spec
  // parts. Returns negative, 0, or positive based on using the sort spec to
  // compare fields.


  _compareKeys(key1, key2) {
    if (key1.length !== this._sortSpecParts.length || key2.length !== this._sortSpecParts.length) {
      throw Error('Key has wrong length');
    }

    return this._keyComparator(key1, key2);
  } // Iterates over each possible "key" from doc (ie, over each branch), calling
  // 'cb' with the key.


  _generateKeysFromDoc(doc, cb) {
    if (this._sortSpecParts.length === 0) {
      throw new Error('can\'t generate keys without a spec');
    }

    const pathFromIndices = indices => "".concat(indices.join(','), ",");

    let knownPaths = null; // maps index -> ({'' -> value} or {path -> value})

    const valuesByIndexAndPath = this._sortSpecParts.map(spec => {
      // Expand any leaf arrays that we find, and ignore those arrays
      // themselves.  (We never sort based on an array itself.)
      let branches = expandArraysInBranches(spec.lookup(doc), true); // If there are no values for a key (eg, key goes to an empty array),
      // pretend we found one undefined value.

      if (!branches.length) {
        branches = [{
          value: void 0
        }];
      }

      const element = Object.create(null);
      let usedPaths = false;
      branches.forEach(branch => {
        if (!branch.arrayIndices) {
          // If there are no array indices for a branch, then it must be the
          // only branch, because the only thing that produces multiple branches
          // is the use of arrays.
          if (branches.length > 1) {
            throw Error('multiple branches but no array used?');
          }

          element[''] = branch.value;
          return;
        }

        usedPaths = true;
        const path = pathFromIndices(branch.arrayIndices);

        if (hasOwn.call(element, path)) {
          throw Error("duplicate path: ".concat(path));
        }

        element[path] = branch.value; // If two sort fields both go into arrays, they have to go into the
        // exact same arrays and we have to find the same paths.  This is
        // roughly the same condition that makes MongoDB throw this strange
        // error message.  eg, the main thing is that if sort spec is {a: 1,
        // b:1} then a and b cannot both be arrays.
        //
        // (In MongoDB it seems to be OK to have {a: 1, 'a.x.y': 1} where 'a'
        // and 'a.x.y' are both arrays, but we don't allow this for now.
        // #NestedArraySort
        // XXX achieve full compatibility here

        if (knownPaths && !hasOwn.call(knownPaths, path)) {
          throw Error('cannot index parallel arrays');
        }
      });

      if (knownPaths) {
        // Similarly to above, paths must match everywhere, unless this is a
        // non-array field.
        if (!hasOwn.call(element, '') && Object.keys(knownPaths).length !== Object.keys(element).length) {
          throw Error('cannot index parallel arrays!');
        }
      } else if (usedPaths) {
        knownPaths = {};
        Object.keys(element).forEach(path => {
          knownPaths[path] = true;
        });
      }

      return element;
    });

    if (!knownPaths) {
      // Easy case: no use of arrays.
      const soleKey = valuesByIndexAndPath.map(values => {
        if (!hasOwn.call(values, '')) {
          throw Error('no value in sole key case?');
        }

        return values[''];
      });
      cb(soleKey);
      return;
    }

    Object.keys(knownPaths).forEach(path => {
      const key = valuesByIndexAndPath.map(values => {
        if (hasOwn.call(values, '')) {
          return values[''];
        }

        if (!hasOwn.call(values, path)) {
          throw Error('missing path?');
        }

        return values[path];
      });
      cb(key);
    });
  } // Returns a comparator that represents the sort specification (but not
  // including a possible geoquery distance tie-breaker).


  _getBaseComparator() {
    if (this._sortFunction) {
      return this._sortFunction;
    } // If we're only sorting on geoquery distance and no specs, just say
    // everything is equal.


    if (!this._sortSpecParts.length) {
      return (doc1, doc2) => 0;
    }

    return (doc1, doc2) => {
      const key1 = this._getMinKeyFromDoc(doc1);

      const key2 = this._getMinKeyFromDoc(doc2);

      return this._compareKeys(key1, key2);
    };
  } // Finds the minimum key from the doc, according to the sort specs.  (We say
  // "minimum" here but this is with respect to the sort spec, so "descending"
  // sort fields mean we're finding the max for that field.)
  //
  // Note that this is NOT "find the minimum value of the first field, the
  // minimum value of the second field, etc"... it's "choose the
  // lexicographically minimum value of the key vector, allowing only keys which
  // you can find along the same paths".  ie, for a doc {a: [{x: 0, y: 5}, {x:
  // 1, y: 3}]} with sort spec {'a.x': 1, 'a.y': 1}, the only keys are [0,5] and
  // [1,3], and the minimum key is [0,5]; notably, [0,3] is NOT a key.


  _getMinKeyFromDoc(doc) {
    let minKey = null;

    this._generateKeysFromDoc(doc, key => {
      if (minKey === null) {
        minKey = key;
        return;
      }

      if (this._compareKeys(key, minKey) < 0) {
        minKey = key;
      }
    });

    return minKey;
  }

  _getPaths() {
    return this._sortSpecParts.map(part => part.path);
  } // Given an index 'i', returns a comparator that compares two key arrays based
  // on field 'i'.


  _keyFieldComparator(i) {
    const invert = !this._sortSpecParts[i].ascending;
    return (key1, key2) => {
      const compare = LocalCollection._f._cmp(key1[i], key2[i]);

      return invert ? -compare : compare;
    };
  }

}

// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
function composeComparators(comparatorArray) {
  return (a, b) => {
    for (let i = 0; i < comparatorArray.length; ++i) {
      const compare = comparatorArray[i](a, b);

      if (compare !== 0) {
        return compare;
      }
    }

    return 0;
  };
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

var exports = require("/node_modules/meteor/minimongo/minimongo_server.js");

/* Exports */
Package._define("minimongo", exports, {
  LocalCollection: LocalCollection,
  Minimongo: Minimongo,
  MinimongoTest: MinimongoTest,
  MinimongoError: MinimongoError
});

})();

//# sourceURL=meteor://💻app/packages/minimongo.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL21pbmltb25nb19zZXJ2ZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jb21tb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jdXJzb3IuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9sb2NhbF9jb2xsZWN0aW9uLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9taW5pbW9uZ28vbWF0Y2hlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL21pbmltb25nb19jb21tb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9vYnNlcnZlX2hhbmRsZS5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL3NvcnRlci5qcyJdLCJuYW1lcyI6WyJtb2R1bGUiLCJsaW5rIiwiaGFzT3duIiwiaXNOdW1lcmljS2V5IiwiaXNPcGVyYXRvck9iamVjdCIsInBhdGhzVG9UcmVlIiwicHJvamVjdGlvbkRldGFpbHMiLCJ2IiwiTWluaW1vbmdvIiwiX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzIiwicGF0aHMiLCJtYXAiLCJwYXRoIiwic3BsaXQiLCJmaWx0ZXIiLCJwYXJ0Iiwiam9pbiIsIk1hdGNoZXIiLCJwcm90b3R5cGUiLCJhZmZlY3RlZEJ5TW9kaWZpZXIiLCJtb2RpZmllciIsIk9iamVjdCIsImFzc2lnbiIsIiRzZXQiLCIkdW5zZXQiLCJtZWFuaW5nZnVsUGF0aHMiLCJfZ2V0UGF0aHMiLCJtb2RpZmllZFBhdGhzIiwiY29uY2F0Iiwia2V5cyIsInNvbWUiLCJtb2QiLCJtZWFuaW5nZnVsUGF0aCIsInNlbCIsImkiLCJqIiwibGVuZ3RoIiwiY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIiLCJpc1NpbXBsZSIsIm1vZGlmaWVyUGF0aHMiLCJwYXRoSGFzTnVtZXJpY0tleXMiLCJleHBlY3RlZFNjYWxhcklzT2JqZWN0IiwiX3NlbGVjdG9yIiwibW9kaWZpZXJQYXRoIiwic3RhcnRzV2l0aCIsIm1hdGNoaW5nRG9jdW1lbnQiLCJFSlNPTiIsImNsb25lIiwiTG9jYWxDb2xsZWN0aW9uIiwiX21vZGlmeSIsImVycm9yIiwibmFtZSIsInNldFByb3BlcnR5RXJyb3IiLCJkb2N1bWVudE1hdGNoZXMiLCJyZXN1bHQiLCJjb21iaW5lSW50b1Byb2plY3Rpb24iLCJwcm9qZWN0aW9uIiwic2VsZWN0b3JQYXRocyIsImluY2x1ZGVzIiwiY29tYmluZUltcG9ydGFudFBhdGhzSW50b1Byb2plY3Rpb24iLCJfbWF0Y2hpbmdEb2N1bWVudCIsInVuZGVmaW5lZCIsImZhbGxiYWNrIiwidmFsdWVTZWxlY3RvciIsIiRlcSIsIiRpbiIsIm1hdGNoZXIiLCJwbGFjZWhvbGRlciIsImZpbmQiLCJvbmx5Q29udGFpbnNLZXlzIiwibG93ZXJCb3VuZCIsIkluZmluaXR5IiwidXBwZXJCb3VuZCIsImZvckVhY2giLCJvcCIsImNhbGwiLCJtaWRkbGUiLCJ4IiwiU29ydGVyIiwiX3NlbGVjdG9yRm9yQWZmZWN0ZWRCeU1vZGlmaWVyIiwiZGV0YWlscyIsInRyZWUiLCJub2RlIiwiZnVsbFBhdGgiLCJtZXJnZWRQcm9qZWN0aW9uIiwidHJlZVRvUGF0aHMiLCJpbmNsdWRpbmciLCJtZXJnZWRFeGNsUHJvamVjdGlvbiIsImdldFBhdGhzIiwic2VsZWN0b3IiLCJfcGF0aHMiLCJvYmoiLCJldmVyeSIsImsiLCJwcmVmaXgiLCJrZXkiLCJ2YWx1ZSIsImV4cG9ydCIsIkVMRU1FTlRfT1BFUkFUT1JTIiwiY29tcGlsZURvY3VtZW50U2VsZWN0b3IiLCJlcXVhbGl0eUVsZW1lbnRNYXRjaGVyIiwiZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyIsImlzSW5kZXhhYmxlIiwibWFrZUxvb2t1cEZ1bmN0aW9uIiwibm90aGluZ01hdGNoZXIiLCJwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzIiwicmVnZXhwRWxlbWVudE1hdGNoZXIiLCJkZWZhdWx0IiwiaGFzT3duUHJvcGVydHkiLCIkbHQiLCJtYWtlSW5lcXVhbGl0eSIsImNtcFZhbHVlIiwiJGd0IiwiJGx0ZSIsIiRndGUiLCIkbW9kIiwiY29tcGlsZUVsZW1lbnRTZWxlY3RvciIsIm9wZXJhbmQiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImRpdmlzb3IiLCJyZW1haW5kZXIiLCJlbGVtZW50TWF0Y2hlcnMiLCJvcHRpb24iLCJSZWdFeHAiLCIkc2l6ZSIsImRvbnRFeHBhbmRMZWFmQXJyYXlzIiwiJHR5cGUiLCJkb250SW5jbHVkZUxlYWZBcnJheXMiLCJvcGVyYW5kQWxpYXNNYXAiLCJfZiIsIl90eXBlIiwiJGJpdHNBbGxTZXQiLCJtYXNrIiwiZ2V0T3BlcmFuZEJpdG1hc2siLCJiaXRtYXNrIiwiZ2V0VmFsdWVCaXRtYXNrIiwiYnl0ZSIsIiRiaXRzQW55U2V0IiwiJGJpdHNBbGxDbGVhciIsIiRiaXRzQW55Q2xlYXIiLCIkcmVnZXgiLCJyZWdleHAiLCIkb3B0aW9ucyIsInRlc3QiLCJzb3VyY2UiLCIkZWxlbU1hdGNoIiwiX2lzUGxhaW5PYmplY3QiLCJpc0RvY01hdGNoZXIiLCJMT0dJQ0FMX09QRVJBVE9SUyIsInJlZHVjZSIsImEiLCJiIiwic3ViTWF0Y2hlciIsImluRWxlbU1hdGNoIiwiY29tcGlsZVZhbHVlU2VsZWN0b3IiLCJhcnJheUVsZW1lbnQiLCJhcmciLCJkb250SXRlcmF0ZSIsIiRhbmQiLCJzdWJTZWxlY3RvciIsImFuZERvY3VtZW50TWF0Y2hlcnMiLCJjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzIiwiJG9yIiwibWF0Y2hlcnMiLCJkb2MiLCJmbiIsIiRub3IiLCIkd2hlcmUiLCJzZWxlY3RvclZhbHVlIiwiX3JlY29yZFBhdGhVc2VkIiwiX2hhc1doZXJlIiwiRnVuY3Rpb24iLCIkY29tbWVudCIsIlZBTFVFX09QRVJBVE9SUyIsImNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyIiwiJG5vdCIsImludmVydEJyYW5jaGVkTWF0Y2hlciIsIiRuZSIsIiRuaW4iLCIkZXhpc3RzIiwiZXhpc3RzIiwiZXZlcnl0aGluZ01hdGNoZXIiLCIkbWF4RGlzdGFuY2UiLCIkbmVhciIsIiRhbGwiLCJicmFuY2hlZE1hdGNoZXJzIiwiY3JpdGVyaW9uIiwiYW5kQnJhbmNoZWRNYXRjaGVycyIsImlzUm9vdCIsIl9oYXNHZW9RdWVyeSIsIm1heERpc3RhbmNlIiwicG9pbnQiLCJkaXN0YW5jZSIsIiRnZW9tZXRyeSIsInR5cGUiLCJHZW9KU09OIiwicG9pbnREaXN0YW5jZSIsImNvb3JkaW5hdGVzIiwicG9pbnRUb0FycmF5IiwiZ2VvbWV0cnlXaXRoaW5SYWRpdXMiLCJkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyIsImJyYW5jaGVkVmFsdWVzIiwiYnJhbmNoIiwiY3VyRGlzdGFuY2UiLCJfaXNVcGRhdGUiLCJhcnJheUluZGljZXMiLCJhbmRTb21lTWF0Y2hlcnMiLCJzdWJNYXRjaGVycyIsImRvY09yQnJhbmNoZXMiLCJtYXRjaCIsInN1YlJlc3VsdCIsInNlbGVjdG9ycyIsImRvY1NlbGVjdG9yIiwib3B0aW9ucyIsImRvY01hdGNoZXJzIiwic3Vic3RyIiwiX2lzU2ltcGxlIiwibG9va1VwQnlJbmRleCIsInZhbHVlTWF0Y2hlciIsIkJvb2xlYW4iLCJvcGVyYXRvckJyYW5jaGVkTWF0Y2hlciIsImVsZW1lbnRNYXRjaGVyIiwiYnJhbmNoZXMiLCJleHBhbmRlZCIsImVsZW1lbnQiLCJtYXRjaGVkIiwicG9pbnRBIiwicG9pbnRCIiwiTWF0aCIsImh5cG90IiwiZWxlbWVudFNlbGVjdG9yIiwiX2VxdWFsIiwiZG9jT3JCcmFuY2hlZFZhbHVlcyIsInNraXBUaGVBcnJheXMiLCJicmFuY2hlc091dCIsInRoaXNJc0FycmF5IiwicHVzaCIsIk51bWJlciIsImlzSW50ZWdlciIsIlVpbnQ4QXJyYXkiLCJJbnQzMkFycmF5IiwiYnVmZmVyIiwiaXNCaW5hcnkiLCJBcnJheUJ1ZmZlciIsIm1heCIsInZpZXciLCJpc1NhZmVJbnRlZ2VyIiwiVWludDMyQXJyYXkiLCJCWVRFU19QRVJfRUxFTUVOVCIsImluc2VydEludG9Eb2N1bWVudCIsImRvY3VtZW50IiwiZXhpc3RpbmdLZXkiLCJpbmRleE9mIiwiYnJhbmNoZWRNYXRjaGVyIiwiYnJhbmNoVmFsdWVzIiwicyIsImluY29uc2lzdGVudE9LIiwidGhlc2VBcmVPcGVyYXRvcnMiLCJzZWxLZXkiLCJ0aGlzSXNPcGVyYXRvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJjbXBWYWx1ZUNvbXBhcmF0b3IiLCJvcGVyYW5kVHlwZSIsIl9jbXAiLCJwYXJ0cyIsImZpcnN0UGFydCIsImxvb2t1cFJlc3QiLCJzbGljZSIsIm9taXRVbm5lY2Vzc2FyeUZpZWxkcyIsImZpcnN0TGV2ZWwiLCJhcHBlbmRUb1Jlc3VsdCIsIm1vcmUiLCJmb3JTb3J0IiwiYXJyYXlJbmRleCIsIk1pbmltb25nb1Rlc3QiLCJNaW5pbW9uZ29FcnJvciIsIm1lc3NhZ2UiLCJmaWVsZCIsIm9wZXJhdG9yTWF0Y2hlcnMiLCJvcGVyYXRvciIsInNpbXBsZVJhbmdlIiwic2ltcGxlRXF1YWxpdHkiLCJzaW1wbGVJbmNsdXNpb24iLCJuZXdMZWFmRm4iLCJjb25mbGljdEZuIiwicm9vdCIsInBhdGhBcnJheSIsInN1Y2Nlc3MiLCJsYXN0S2V5IiwieSIsInBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUiLCJnZXRQcm90b3R5cGVPZiIsInBvcHVsYXRlRG9jdW1lbnRXaXRoT2JqZWN0IiwidW5wcmVmaXhlZEtleXMiLCJ2YWxpZGF0ZU9iamVjdCIsIm9iamVjdCIsInF1ZXJ5IiwiX3NlbGVjdG9ySXNJZCIsImZpZWxkcyIsImZpZWxkc0tleXMiLCJzb3J0IiwiX2lkIiwia2V5UGF0aCIsInJ1bGUiLCJwcm9qZWN0aW9uUnVsZXNUcmVlIiwiY3VycmVudFBhdGgiLCJhbm90aGVyUGF0aCIsInRvU3RyaW5nIiwibGFzdEluZGV4IiwidmFsaWRhdGVLZXlJblBhdGgiLCJDdXJzb3IiLCJjb25zdHJ1Y3RvciIsImNvbGxlY3Rpb24iLCJzb3J0ZXIiLCJfc2VsZWN0b3JJc0lkUGVyaGFwc0FzT2JqZWN0IiwiX3NlbGVjdG9ySWQiLCJoYXNHZW9RdWVyeSIsInNraXAiLCJsaW1pdCIsIl9wcm9qZWN0aW9uRm4iLCJfY29tcGlsZVByb2plY3Rpb24iLCJfdHJhbnNmb3JtIiwid3JhcFRyYW5zZm9ybSIsInRyYW5zZm9ybSIsIlRyYWNrZXIiLCJyZWFjdGl2ZSIsImNvdW50IiwiYXBwbHlTa2lwTGltaXQiLCJfZGVwZW5kIiwiYWRkZWQiLCJyZW1vdmVkIiwiX2dldFJhd09iamVjdHMiLCJvcmRlcmVkIiwiZmV0Y2giLCJTeW1ib2wiLCJpdGVyYXRvciIsImFkZGVkQmVmb3JlIiwiY2hhbmdlZCIsIm1vdmVkQmVmb3JlIiwiaW5kZXgiLCJvYmplY3RzIiwibmV4dCIsImRvbmUiLCJjYWxsYmFjayIsInRoaXNBcmciLCJnZXRUcmFuc2Zvcm0iLCJvYnNlcnZlIiwiX29ic2VydmVGcm9tT2JzZXJ2ZUNoYW5nZXMiLCJvYnNlcnZlQ2hhbmdlcyIsIl9vYnNlcnZlQ2hhbmdlc0NhbGxiYWNrc0FyZU9yZGVyZWQiLCJfYWxsb3dfdW5vcmRlcmVkIiwiZGlzdGFuY2VzIiwiX0lkTWFwIiwiY3Vyc29yIiwiZGlydHkiLCJwcm9qZWN0aW9uRm4iLCJyZXN1bHRzU25hcHNob3QiLCJxaWQiLCJuZXh0X3FpZCIsInF1ZXJpZXMiLCJyZXN1bHRzIiwicGF1c2VkIiwid3JhcENhbGxiYWNrIiwic2VsZiIsImFyZ3MiLCJhcmd1bWVudHMiLCJfb2JzZXJ2ZVF1ZXVlIiwicXVldWVUYXNrIiwiYXBwbHkiLCJfc3VwcHJlc3NfaW5pdGlhbCIsImhhbmRsZSIsIk9ic2VydmVIYW5kbGUiLCJzdG9wIiwiYWN0aXZlIiwib25JbnZhbGlkYXRlIiwiZHJhaW4iLCJjaGFuZ2VycyIsImRlcGVuZGVuY3kiLCJEZXBlbmRlbmN5Iiwibm90aWZ5IiwiYmluZCIsImRlcGVuZCIsIl9nZXRDb2xsZWN0aW9uTmFtZSIsInNlbGVjdGVkRG9jIiwiX2RvY3MiLCJnZXQiLCJzZXQiLCJjbGVhciIsImlkIiwibWF0Y2hSZXN1bHQiLCJnZXRDb21wYXJhdG9yIiwiX3B1Ymxpc2hDdXJzb3IiLCJzdWJzY3JpcHRpb24iLCJQYWNrYWdlIiwibW9uZ28iLCJNb25nbyIsIkNvbGxlY3Rpb24iLCJfb2JqZWN0U3ByZWFkIiwiTWV0ZW9yIiwiX1N5bmNocm9ub3VzUXVldWUiLCJjcmVhdGUiLCJfc2F2ZWRPcmlnaW5hbHMiLCJmaW5kT25lIiwiaW5zZXJ0IiwiYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzIiwiX3VzZU9JRCIsIk1vbmdvSUQiLCJPYmplY3RJRCIsIlJhbmRvbSIsImhhcyIsIl9zYXZlT3JpZ2luYWwiLCJxdWVyaWVzVG9SZWNvbXB1dGUiLCJfaW5zZXJ0SW5SZXN1bHRzIiwiX3JlY29tcHV0ZVJlc3VsdHMiLCJkZWZlciIsInBhdXNlT2JzZXJ2ZXJzIiwicmVtb3ZlIiwiZXF1YWxzIiwic2l6ZSIsIl9lYWNoUG9zc2libHlNYXRjaGluZ0RvYyIsInF1ZXJ5UmVtb3ZlIiwicmVtb3ZlSWQiLCJyZW1vdmVEb2MiLCJfcmVtb3ZlRnJvbVJlc3VsdHMiLCJyZXN1bWVPYnNlcnZlcnMiLCJfZGlmZlF1ZXJ5Q2hhbmdlcyIsInJldHJpZXZlT3JpZ2luYWxzIiwib3JpZ2luYWxzIiwic2F2ZU9yaWdpbmFscyIsInVwZGF0ZSIsInFpZFRvT3JpZ2luYWxSZXN1bHRzIiwiZG9jTWFwIiwiaWRzTWF0Y2hlZCIsIl9pZHNNYXRjaGVkQnlTZWxlY3RvciIsIm1lbW9pemVkQ2xvbmVJZk5lZWRlZCIsImRvY1RvTWVtb2l6ZSIsInJlY29tcHV0ZVFpZHMiLCJ1cGRhdGVDb3VudCIsInF1ZXJ5UmVzdWx0IiwiX21vZGlmeUFuZE5vdGlmeSIsIm11bHRpIiwiaW5zZXJ0ZWRJZCIsInVwc2VydCIsIl9jcmVhdGVVcHNlcnREb2N1bWVudCIsIl9yZXR1cm5PYmplY3QiLCJudW1iZXJBZmZlY3RlZCIsInNwZWNpZmljSWRzIiwibWF0Y2hlZF9iZWZvcmUiLCJvbGRfZG9jIiwiYWZ0ZXJNYXRjaCIsImFmdGVyIiwiYmVmb3JlIiwiX3VwZGF0ZUluUmVzdWx0cyIsIm9sZFJlc3VsdHMiLCJfQ2FjaGluZ0NoYW5nZU9ic2VydmVyIiwib3JkZXJlZEZyb21DYWxsYmFja3MiLCJjYWxsYmFja3MiLCJkb2NzIiwiT3JkZXJlZERpY3QiLCJpZFN0cmluZ2lmeSIsImFwcGx5Q2hhbmdlIiwicHV0QmVmb3JlIiwibW92ZUJlZm9yZSIsIkRpZmZTZXF1ZW5jZSIsImFwcGx5Q2hhbmdlcyIsIklkTWFwIiwiaWRQYXJzZSIsIl9fd3JhcHBlZFRyYW5zZm9ybV9fIiwid3JhcHBlZCIsInRyYW5zZm9ybWVkIiwibm9ucmVhY3RpdmUiLCJfYmluYXJ5U2VhcmNoIiwiY21wIiwiYXJyYXkiLCJmaXJzdCIsInJhbmdlIiwiaGFsZlJhbmdlIiwiZmxvb3IiLCJfY2hlY2tTdXBwb3J0ZWRQcm9qZWN0aW9uIiwiX2lkUHJvamVjdGlvbiIsInJ1bGVUcmVlIiwic3ViZG9jIiwic2VsZWN0b3JEb2N1bWVudCIsImlzTW9kaWZ5IiwiX2lzTW9kaWZpY2F0aW9uTW9kIiwibmV3RG9jIiwiaXNJbnNlcnQiLCJyZXBsYWNlbWVudCIsIl9kaWZmT2JqZWN0cyIsImxlZnQiLCJyaWdodCIsImRpZmZPYmplY3RzIiwibmV3UmVzdWx0cyIsIm9ic2VydmVyIiwiZGlmZlF1ZXJ5Q2hhbmdlcyIsIl9kaWZmUXVlcnlPcmRlcmVkQ2hhbmdlcyIsImRpZmZRdWVyeU9yZGVyZWRDaGFuZ2VzIiwiX2RpZmZRdWVyeVVub3JkZXJlZENoYW5nZXMiLCJkaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzIiwiX2ZpbmRJbk9yZGVyZWRSZXN1bHRzIiwic3ViSWRzIiwiX2luc2VydEluU29ydGVkTGlzdCIsInNwbGljZSIsImlzUmVwbGFjZSIsImlzTW9kaWZpZXIiLCJzZXRPbkluc2VydCIsIm1vZEZ1bmMiLCJNT0RJRklFUlMiLCJrZXlwYXRoIiwia2V5cGFydHMiLCJ0YXJnZXQiLCJmaW5kTW9kVGFyZ2V0IiwiZm9yYmlkQXJyYXkiLCJub0NyZWF0ZSIsIk5PX0NSRUFURV9NT0RJRklFUlMiLCJwb3AiLCJvYnNlcnZlQ2FsbGJhY2tzIiwic3VwcHJlc3NlZCIsIm9ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzIiwiX29ic2VydmVDYWxsYmFja3NBcmVPcmRlcmVkIiwiaW5kaWNlcyIsIl9ub19pbmRpY2VzIiwiYWRkZWRBdCIsImNoYW5nZWRBdCIsIm9sZERvYyIsIm1vdmVkVG8iLCJmcm9tIiwidG8iLCJyZW1vdmVkQXQiLCJjaGFuZ2VPYnNlcnZlciIsIl9mcm9tT2JzZXJ2ZSIsIm5vbk11dGF0aW5nQ2FsbGJhY2tzIiwiY2hhbmdlZEZpZWxkcyIsIm1ha2VDaGFuZ2VkRmllbGRzIiwib2xkX2lkeCIsIm5ld19pZHgiLCIkY3VycmVudERhdGUiLCJEYXRlIiwiJGluYyIsIiRtaW4iLCIkbWF4IiwiJG11bCIsIiRyZW5hbWUiLCJ0YXJnZXQyIiwiJHNldE9uSW5zZXJ0IiwiJHB1c2giLCIkZWFjaCIsInRvUHVzaCIsInBvc2l0aW9uIiwiJHBvc2l0aW9uIiwiJHNsaWNlIiwic29ydEZ1bmN0aW9uIiwiJHNvcnQiLCJzcGxpY2VBcmd1bWVudHMiLCIkcHVzaEFsbCIsIiRhZGRUb1NldCIsImlzRWFjaCIsInZhbHVlcyIsInRvQWRkIiwiJHBvcCIsInRvUG9wIiwiJHB1bGwiLCJ0b1B1bGwiLCJvdXQiLCIkcHVsbEFsbCIsIiRiaXQiLCIkdiIsImludmFsaWRDaGFyTXNnIiwiJCIsImFzc2VydElzVmFsaWRGaWVsZE5hbWUiLCJ1c2VkQXJyYXlJbmRleCIsImxhc3QiLCJrZXlwYXJ0IiwicGFyc2VJbnQiLCJEZWNpbWFsIiwiRGVjaW1hbFN0dWIiLCJpc1VwZGF0ZSIsIl9kb2NNYXRjaGVyIiwiX2NvbXBpbGVTZWxlY3RvciIsImhhc1doZXJlIiwia2V5T3JkZXJTZW5zaXRpdmUiLCJfdHlwZW9yZGVyIiwidCIsInRhIiwidGIiLCJvYSIsIm9iIiwidG9IZXhTdHJpbmciLCJnZXRUaW1lIiwibWludXMiLCJ0b051bWJlciIsInRvQXJyYXkiLCJMb2NhbENvbGxlY3Rpb25fIiwic3BlYyIsIl9zb3J0U3BlY1BhcnRzIiwiX3NvcnRGdW5jdGlvbiIsImFkZFNwZWNQYXJ0IiwiYXNjZW5kaW5nIiwiY2hhckF0IiwibG9va3VwIiwiX2tleUNvbXBhcmF0b3IiLCJjb21wb3NlQ29tcGFyYXRvcnMiLCJfa2V5RmllbGRDb21wYXJhdG9yIiwiX2dldEJhc2VDb21wYXJhdG9yIiwiX2NvbXBhcmVLZXlzIiwia2V5MSIsImtleTIiLCJfZ2VuZXJhdGVLZXlzRnJvbURvYyIsImNiIiwicGF0aEZyb21JbmRpY2VzIiwia25vd25QYXRocyIsInZhbHVlc0J5SW5kZXhBbmRQYXRoIiwidXNlZFBhdGhzIiwic29sZUtleSIsImRvYzEiLCJkb2MyIiwiX2dldE1pbktleUZyb21Eb2MiLCJtaW5LZXkiLCJpbnZlcnQiLCJjb21wYXJlIiwiY29tcGFyYXRvckFycmF5Il0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUFBLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLHVCQUFaO0FBQXFDLElBQUlDLE1BQUosRUFBV0MsWUFBWCxFQUF3QkMsZ0JBQXhCLEVBQXlDQyxXQUF6QyxFQUFxREMsaUJBQXJEO0FBQXVFTixNQUFNLENBQUNDLElBQVAsQ0FBWSxhQUFaLEVBQTBCO0FBQUNDLFFBQU0sQ0FBQ0ssQ0FBRCxFQUFHO0FBQUNMLFVBQU0sR0FBQ0ssQ0FBUDtBQUFTLEdBQXBCOztBQUFxQkosY0FBWSxDQUFDSSxDQUFELEVBQUc7QUFBQ0osZ0JBQVksR0FBQ0ksQ0FBYjtBQUFlLEdBQXBEOztBQUFxREgsa0JBQWdCLENBQUNHLENBQUQsRUFBRztBQUFDSCxvQkFBZ0IsR0FBQ0csQ0FBakI7QUFBbUIsR0FBNUY7O0FBQTZGRixhQUFXLENBQUNFLENBQUQsRUFBRztBQUFDRixlQUFXLEdBQUNFLENBQVo7QUFBYyxHQUExSDs7QUFBMkhELG1CQUFpQixDQUFDQyxDQUFELEVBQUc7QUFBQ0Qs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QVA7QUFDRDtBQUNGOztBQUVELFdBQU8sQ0FBUDtBQUNELEdBVEQ7QUFVRCxDIiwiZmlsZSI6Ii9wYWNrYWdlcy9taW5pbW9uZ28uanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgJy4vbWluaW1vbmdvX2NvbW1vbi5qcyc7XG5pbXBvcnQge1xuICBoYXNPd24sXG4gIGlzTnVtZXJpY0tleSxcbiAgaXNPcGVyYXRvck9iamVjdCxcbiAgcGF0aHNUb1RyZWUsXG4gIHByb2plY3Rpb25EZXRhaWxzLFxufSBmcm9tICcuL2NvbW1vbi5qcyc7XG5cbk1pbmltb25nby5fcGF0aHNFbGlkaW5nTnVtZXJpY0tleXMgPSBwYXRocyA9PiBwYXRocy5tYXAocGF0aCA9PlxuICBwYXRoLnNwbGl0KCcuJykuZmlsdGVyKHBhcnQgPT4gIWlzTnVtZXJpY0tleShwYXJ0KSkuam9pbignLicpXG4pO1xuXG4vLyBSZXR1cm5zIHRydWUgaWYgdGhlIG1vZGlmaWVyIGFwcGxpZWQgdG8gc29tZSBkb2N1bWVudCBtYXkgY2hhbmdlIHRoZSByZXN1bHRcbi8vIG9mIG1hdGNoaW5nIHRoZSBkb2N1bWVudCBieSBzZWxlY3RvclxuLy8gVGhlIG1vZGlmaWVyIGlzIGFsd2F5cyBpbiBhIGZvcm0gb2YgT2JqZWN0OlxuLy8gIC0gJHNldFxuLy8gICAgLSAnYS5iLjIyLnonOiB2YWx1ZVxuLy8gICAgLSAnZm9vLmJhcic6IDQyXG4vLyAgLSAkdW5zZXRcbi8vICAgIC0gJ2FiYy5kJzogMVxuTWluaW1vbmdvLk1hdGNoZXIucHJvdG90eXBlLmFmZmVjdGVkQnlNb2RpZmllciA9IGZ1bmN0aW9uKG1vZGlmaWVyKSB7XG4gIC8vIHNhZmUgY2hlY2sgZm9yICRzZXQvJHVuc2V0IGJlaW5nIG9iamVjdHNcbiAgbW9kaWZpZXIgPSBPYmplY3QuYXNzaWduKHskc2V0OiB7fSwgJHVuc2V0OiB7fX0sIG1vZGlmaWVyKTtcblxuICBjb25zdCBtZWFuaW5nZnVsUGF0aHMgPSB0aGlzLl9nZXRQYXRocygpO1xuICBjb25zdCBtb2RpZmllZFBhdGhzID0gW10uY29uY2F0KFxuICAgIE9iamVjdC5rZXlzKG1vZGlmaWVyLiRzZXQpLFxuICAgIE9iamVjdC5rZXlzKG1vZGlmaWVyLiR1bnNldClcbiAgKTtcblxuICByZXR1cm4gbW9kaWZpZWRQYXRocy5zb21lKHBhdGggPT4ge1xuICAgIGNvbnN0IG1vZCA9IHBhdGguc3BsaXQoJy4nKTtcblxuICAgIHJldHVybiBtZWFuaW5nZnVsUGF0aHMuc29tZShtZWFuaW5nZnVsUGF0aCA9PiB7XG4gICAgICBjb25zdCBzZWwgPSBtZWFuaW5nZnVsUGF0aC5zcGxpdCgnLicpO1xuXG4gICAgICBsZXQgaSA9IDAsIGogPSAwO1xuXG4gICAgICB3aGlsZSAoaSA8IHNlbC5sZW5ndGggJiYgaiA8IG1vZC5sZW5ndGgpIHtcbiAgICAgICAgaWYgKGlzTnVtZXJpY0tleShzZWxbaV0pICYmIGlzTnVtZXJpY0tleShtb2Rbal0pKSB7XG4gICAgICAgICAgLy8gZm9vLjQuYmFyIHNlbGVjdG9yIGFmZmVjdGVkIGJ5IGZvby40IG1vZGlmaWVyXG4gICAgICAgICAgLy8gZm9vLjMuYmFyIHNlbGVjdG9yIHVuYWZmZWN0ZWQgYnkgZm9vLjQgbW9kaWZpZXJcbiAgICAgICAgICBpZiAoc2VsW2ldID09PSBtb2Rbal0pIHtcbiAgICAgICAgICAgIGkrKztcbiAgICAgICAgICAgIGorKztcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChpc051bWVyaWNLZXkoc2VsW2ldKSkge1xuICAgICAgICAgIC8vIGZvby40LmJhciBzZWxlY3RvciB1bmFmZmVjdGVkIGJ5IGZvby5iYXIgbW9kaWZpZXJcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH0gZWxzZSBpZiAoaXNOdW1lcmljS2V5KG1vZFtqXSkpIHtcbiAgICAgICAgICBqKys7XG4gICAgICAgIH0gZWxzZSBpZiAoc2VsW2ldID09PSBtb2Rbal0pIHtcbiAgICAgICAgICBpKys7XG4gICAgICAgICAgaisrO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBPbmUgaXMgYSBwcmVmaXggb2YgYW5vdGhlciwgdGFraW5nIG51bWVyaWMgZmllbGRzIGludG8gYWNjb3VudFxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIH0pO1xufTtcblxuLy8gQHBhcmFtIG1vZGlmaWVyIC0gT2JqZWN0OiBNb25nb0RCLXN0eWxlZCBtb2RpZmllciB3aXRoIGAkc2V0YHMgYW5kIGAkdW5zZXRzYFxuLy8gICAgICAgICAgICAgICAgICAgICAgICAgICBvbmx5LiAoYXNzdW1lZCB0byBjb21lIGZyb20gb3Bsb2cpXG4vLyBAcmV0dXJucyAtIEJvb2xlYW46IGlmIGFmdGVyIGFwcGx5aW5nIHRoZSBtb2RpZmllciwgc2VsZWN0b3IgY2FuIHN0YXJ0XG4vLyAgICAgICAgICAgICAgICAgICAgIGFjY2VwdGluZyB0aGUgbW9kaWZpZWQgdmFsdWUuXG4vLyBOT1RFOiBhc3N1bWVzIHRoYXQgZG9jdW1lbnQgYWZmZWN0ZWQgYnkgbW9kaWZpZXIgZGlkbid0IG1hdGNoIHRoaXMgTWF0Y2hlclxuLy8gYmVmb3JlLCBzbyBpZiBtb2RpZmllciBjYW4ndCBjb252aW5jZSBzZWxlY3RvciBpbiBhIHBvc2l0aXZlIGNoYW5nZSBpdCB3b3VsZFxuLy8gc3RheSAnZmFsc2UnLlxuLy8gQ3VycmVudGx5IGRvZXNuJ3Qgc3VwcG9ydCAkLW9wZXJhdG9ycyBhbmQgbnVtZXJpYyBpbmRpY2VzIHByZWNpc2VseS5cbk1pbmltb25nby5NYXRjaGVyLnByb3RvdHlwZS5jYW5CZWNvbWVUcnVlQnlNb2RpZmllciA9IGZ1bmN0aW9uKG1vZGlmaWVyKSB7XG4gIGlmICghdGhpcy5hZmZlY3RlZEJ5TW9kaWZpZXIobW9kaWZpZXIpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKCF0aGlzLmlzU2ltcGxlKCkpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIG1vZGlmaWVyID0gT2JqZWN0LmFzc2lnbih7JHNldDoge30sICR1bnNldDoge319LCBtb2RpZmllcik7XG5cbiAgY29uc3QgbW9kaWZpZXJQYXRocyA9IFtdLmNvbmNhdChcbiAgICBPYmplY3Qua2V5cyhtb2RpZmllci4kc2V0KSxcbiAgICBPYmplY3Qua2V5cyhtb2RpZmllci4kdW5zZXQpXG4gICk7XG5cbiAgaWYgKHRoaXMuX2dldFBhdGhzKCkuc29tZShwYXRoSGFzTnVtZXJpY0tleXMpIHx8XG4gICAgICBtb2RpZmllclBhdGhzLnNvbWUocGF0aEhhc051bWVyaWNLZXlzKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gY2hlY2sgaWYgdGhlcmUgaXMgYSAkc2V0IG9yICR1bnNldCB0aGF0IGluZGljYXRlcyBzb21ldGhpbmcgaXMgYW5cbiAgLy8gb2JqZWN0IHJhdGhlciB0aGFuIGEgc2NhbGFyIGluIHRoZSBhY3R1YWwgb2JqZWN0IHdoZXJlIHdlIHNhdyAkLW9wZXJhdG9yXG4gIC8vIE5PVEU6IGl0IGlzIGNvcnJlY3Qgc2luY2Ugd2UgYWxsb3cgb25seSBzY2FsYXJzIGluICQtb3BlcmF0b3JzXG4gIC8vIEV4YW1wbGU6IGZvciBzZWxlY3RvciB7J2EuYic6IHskZ3Q6IDV9fSB0aGUgbW9kaWZpZXIgeydhLmIuYyc6N30gd291bGRcbiAgLy8gZGVmaW5pdGVseSBzZXQgdGhlIHJlc3VsdCB0byBmYWxzZSBhcyAnYS5iJyBhcHBlYXJzIHRvIGJlIGFuIG9iamVjdC5cbiAgY29uc3QgZXhwZWN0ZWRTY2FsYXJJc09iamVjdCA9IE9iamVjdC5rZXlzKHRoaXMuX3NlbGVjdG9yKS5zb21lKHBhdGggPT4ge1xuICAgIGlmICghaXNPcGVyYXRvck9iamVjdCh0aGlzLl9zZWxlY3RvcltwYXRoXSkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICByZXR1cm4gbW9kaWZpZXJQYXRocy5zb21lKG1vZGlmaWVyUGF0aCA9PlxuICAgICAgbW9kaWZpZXJQYXRoLnN0YXJ0c1dpdGgoYCR7cGF0aH0uYClcbiAgICApO1xuICB9KTtcblxuICBpZiAoZXhwZWN0ZWRTY2FsYXJJc09iamVjdCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFNlZSBpZiB3ZSBjYW4gYXBwbHkgdGhlIG1vZGlmaWVyIG9uIHRoZSBpZGVhbGx5IG1hdGNoaW5nIG9iamVjdC4gSWYgaXRcbiAgLy8gc3RpbGwgbWF0Y2hlcyB0aGUgc2VsZWN0b3IsIHRoZW4gdGhlIG1vZGlmaWVyIGNvdWxkIGhhdmUgdHVybmVkIHRoZSByZWFsXG4gIC8vIG9iamVjdCBpbiB0aGUgZGF0YWJhc2UgaW50byBzb21ldGhpbmcgbWF0Y2hpbmcuXG4gIGNvbnN0IG1hdGNoaW5nRG9jdW1lbnQgPSBFSlNPTi5jbG9uZSh0aGlzLm1hdGNoaW5nRG9jdW1lbnQoKSk7XG5cbiAgLy8gVGhlIHNlbGVjdG9yIGlzIHRvbyBjb21wbGV4LCBhbnl0aGluZyBjYW4gaGFwcGVuLlxuICBpZiAobWF0Y2hpbmdEb2N1bWVudCA9PT0gbnVsbCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBMb2NhbENvbGxlY3Rpb24uX21vZGlmeShtYXRjaGluZ0RvY3VtZW50LCBtb2RpZmllcik7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gQ291bGRuJ3Qgc2V0IGEgcHJvcGVydHkgb24gYSBmaWVsZCB3aGljaCBpcyBhIHNjYWxhciBvciBudWxsIGluIHRoZVxuICAgIC8vIHNlbGVjdG9yLlxuICAgIC8vIEV4YW1wbGU6XG4gICAgLy8gcmVhbCBkb2N1bWVudDogeyAnYS5iJzogMyB9XG4gICAgLy8gc2VsZWN0b3I6IHsgJ2EnOiAxMiB9XG4gICAgLy8gY29udmVydGVkIHNlbGVjdG9yIChpZGVhbCBkb2N1bWVudCk6IHsgJ2EnOiAxMiB9XG4gICAgLy8gbW9kaWZpZXI6IHsgJHNldDogeyAnYS5iJzogNCB9IH1cbiAgICAvLyBXZSBkb24ndCBrbm93IHdoYXQgcmVhbCBkb2N1bWVudCB3YXMgbGlrZSBidXQgZnJvbSB0aGUgZXJyb3IgcmFpc2VkIGJ5XG4gICAgLy8gJHNldCBvbiBhIHNjYWxhciBmaWVsZCB3ZSBjYW4gcmVhc29uIHRoYXQgdGhlIHN0cnVjdHVyZSBvZiByZWFsIGRvY3VtZW50XG4gICAgLy8gaXMgY29tcGxldGVseSBkaWZmZXJlbnQuXG4gICAgaWYgKGVycm9yLm5hbWUgPT09ICdNaW5pbW9uZ29FcnJvcicgJiYgZXJyb3Iuc2V0UHJvcGVydHlFcnJvcikge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHRocm93IGVycm9yO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMuZG9jdW1lbnRNYXRjaGVzKG1hdGNoaW5nRG9jdW1lbnQpLnJlc3VsdDtcbn07XG5cbi8vIEtub3dzIGhvdyB0byBjb21iaW5lIGEgbW9uZ28gc2VsZWN0b3IgYW5kIGEgZmllbGRzIHByb2plY3Rpb24gdG8gYSBuZXcgZmllbGRzXG4vLyBwcm9qZWN0aW9uIHRha2luZyBpbnRvIGFjY291bnQgYWN0aXZlIGZpZWxkcyBmcm9tIHRoZSBwYXNzZWQgc2VsZWN0b3IuXG4vLyBAcmV0dXJucyBPYmplY3QgLSBwcm9qZWN0aW9uIG9iamVjdCAoc2FtZSBhcyBmaWVsZHMgb3B0aW9uIG9mIG1vbmdvIGN1cnNvcilcbk1pbmltb25nby5NYXRjaGVyLnByb3RvdHlwZS5jb21iaW5lSW50b1Byb2plY3Rpb24gPSBmdW5jdGlvbihwcm9qZWN0aW9uKSB7XG4gIGNvbnN0IHNlbGVjdG9yUGF0aHMgPSBNaW5pbW9uZ28uX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzKHRoaXMuX2dldFBhdGhzKCkpO1xuXG4gIC8vIFNwZWNpYWwgY2FzZSBmb3IgJHdoZXJlIG9wZXJhdG9yIGluIHRoZSBzZWxlY3RvciAtIHByb2plY3Rpb24gc2hvdWxkIGRlcGVuZFxuICAvLyBvbiBhbGwgZmllbGRzIG9mIHRoZSBkb2N1bWVudC4gZ2V0U2VsZWN0b3JQYXRocyByZXR1cm5zIGEgbGlzdCBvZiBwYXRoc1xuICAvLyBzZWxlY3RvciBkZXBlbmRzIG9uLiBJZiBvbmUgb2YgdGhlIHBhdGhzIGlzICcnIChlbXB0eSBzdHJpbmcpIHJlcHJlc2VudGluZ1xuICAvLyB0aGUgcm9vdCBvciB0aGUgd2hvbGUgZG9jdW1lbnQsIGNvbXBsZXRlIHByb2plY3Rpb24gc2hvdWxkIGJlIHJldHVybmVkLlxuICBpZiAoc2VsZWN0b3JQYXRocy5pbmNsdWRlcygnJykpIHtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICByZXR1cm4gY29tYmluZUltcG9ydGFudFBhdGhzSW50b1Byb2plY3Rpb24oc2VsZWN0b3JQYXRocywgcHJvamVjdGlvbik7XG59O1xuXG4vLyBSZXR1cm5zIGFuIG9iamVjdCB0aGF0IHdvdWxkIG1hdGNoIHRoZSBzZWxlY3RvciBpZiBwb3NzaWJsZSBvciBudWxsIGlmIHRoZVxuLy8gc2VsZWN0b3IgaXMgdG9vIGNvbXBsZXggZm9yIHVzIHRvIGFuYWx5emVcbi8vIHsgJ2EuYic6IHsgYW5zOiA0MiB9LCAnZm9vLmJhcic6IG51bGwsICdmb28uYmF6JzogXCJzb21ldGhpbmdcIiB9XG4vLyA9PiB7IGE6IHsgYjogeyBhbnM6IDQyIH0gfSwgZm9vOiB7IGJhcjogbnVsbCwgYmF6OiBcInNvbWV0aGluZ1wiIH0gfVxuTWluaW1vbmdvLk1hdGNoZXIucHJvdG90eXBlLm1hdGNoaW5nRG9jdW1lbnQgPSBmdW5jdGlvbigpIHtcbiAgLy8gY2hlY2sgaWYgaXQgd2FzIGNvbXB1dGVkIGJlZm9yZVxuICBpZiAodGhpcy5fbWF0Y2hpbmdEb2N1bWVudCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQ7XG4gIH1cblxuICAvLyBJZiB0aGUgYW5hbHlzaXMgb2YgdGhpcyBzZWxlY3RvciBpcyB0b28gaGFyZCBmb3Igb3VyIGltcGxlbWVudGF0aW9uXG4gIC8vIGZhbGxiYWNrIHRvIFwiWUVTXCJcbiAgbGV0IGZhbGxiYWNrID0gZmFsc2U7XG5cbiAgdGhpcy5fbWF0Y2hpbmdEb2N1bWVudCA9IHBhdGhzVG9UcmVlKFxuICAgIHRoaXMuX2dldFBhdGhzKCksXG4gICAgcGF0aCA9PiB7XG4gICAgICBjb25zdCB2YWx1ZVNlbGVjdG9yID0gdGhpcy5fc2VsZWN0b3JbcGF0aF07XG5cbiAgICAgIGlmIChpc09wZXJhdG9yT2JqZWN0KHZhbHVlU2VsZWN0b3IpKSB7XG4gICAgICAgIC8vIGlmIHRoZXJlIGlzIGEgc3RyaWN0IGVxdWFsaXR5LCB0aGVyZSBpcyBhIGdvb2RcbiAgICAgICAgLy8gY2hhbmNlIHdlIGNhbiB1c2Ugb25lIG9mIHRob3NlIGFzIFwibWF0Y2hpbmdcIlxuICAgICAgICAvLyBkdW1teSB2YWx1ZVxuICAgICAgICBpZiAodmFsdWVTZWxlY3Rvci4kZXEpIHtcbiAgICAgICAgICByZXR1cm4gdmFsdWVTZWxlY3Rvci4kZXE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWVTZWxlY3Rvci4kaW4pIHtcbiAgICAgICAgICBjb25zdCBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHtwbGFjZWhvbGRlcjogdmFsdWVTZWxlY3Rvcn0pO1xuXG4gICAgICAgICAgLy8gUmV0dXJuIGFueXRoaW5nIGZyb20gJGluIHRoYXQgbWF0Y2hlcyB0aGUgd2hvbGUgc2VsZWN0b3IgZm9yIHRoaXNcbiAgICAgICAgICAvLyBwYXRoLiBJZiBub3RoaW5nIG1hdGNoZXMsIHJldHVybnMgYHVuZGVmaW5lZGAgYXMgbm90aGluZyBjYW4gbWFrZVxuICAgICAgICAgIC8vIHRoaXMgc2VsZWN0b3IgaW50byBgdHJ1ZWAuXG4gICAgICAgICAgcmV0dXJuIHZhbHVlU2VsZWN0b3IuJGluLmZpbmQocGxhY2Vob2xkZXIgPT5cbiAgICAgICAgICAgIG1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKHtwbGFjZWhvbGRlcn0pLnJlc3VsdFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob25seUNvbnRhaW5zS2V5cyh2YWx1ZVNlbGVjdG9yLCBbJyRndCcsICckZ3RlJywgJyRsdCcsICckbHRlJ10pKSB7XG4gICAgICAgICAgbGV0IGxvd2VyQm91bmQgPSAtSW5maW5pdHk7XG4gICAgICAgICAgbGV0IHVwcGVyQm91bmQgPSBJbmZpbml0eTtcblxuICAgICAgICAgIFsnJGx0ZScsICckbHQnXS5mb3JFYWNoKG9wID0+IHtcbiAgICAgICAgICAgIGlmIChoYXNPd24uY2FsbCh2YWx1ZVNlbGVjdG9yLCBvcCkgJiZcbiAgICAgICAgICAgICAgICB2YWx1ZVNlbGVjdG9yW29wXSA8IHVwcGVyQm91bmQpIHtcbiAgICAgICAgICAgICAgdXBwZXJCb3VuZCA9IHZhbHVlU2VsZWN0b3Jbb3BdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgWyckZ3RlJywgJyRndCddLmZvckVhY2gob3AgPT4ge1xuICAgICAgICAgICAgaWYgKGhhc093bi5jYWxsKHZhbHVlU2VsZWN0b3IsIG9wKSAmJlxuICAgICAgICAgICAgICAgIHZhbHVlU2VsZWN0b3Jbb3BdID4gbG93ZXJCb3VuZCkge1xuICAgICAgICAgICAgICBsb3dlckJvdW5kID0gdmFsdWVTZWxlY3RvcltvcF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBjb25zdCBtaWRkbGUgPSAobG93ZXJCb3VuZCArIHVwcGVyQm91bmQpIC8gMjtcbiAgICAgICAgICBjb25zdCBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHtwbGFjZWhvbGRlcjogdmFsdWVTZWxlY3Rvcn0pO1xuXG4gICAgICAgICAgaWYgKCFtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyh7cGxhY2Vob2xkZXI6IG1pZGRsZX0pLnJlc3VsdCAmJlxuICAgICAgICAgICAgICAobWlkZGxlID09PSBsb3dlckJvdW5kIHx8IG1pZGRsZSA9PT0gdXBwZXJCb3VuZCkpIHtcbiAgICAgICAgICAgIGZhbGxiYWNrID0gdHJ1ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICByZXR1cm4gbWlkZGxlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9ubHlDb250YWluc0tleXModmFsdWVTZWxlY3RvciwgWyckbmluJywgJyRuZSddKSkge1xuICAgICAgICAgIC8vIFNpbmNlIHRoaXMuX2lzU2ltcGxlIG1ha2VzIHN1cmUgJG5pbiBhbmQgJG5lIGFyZSBub3QgY29tYmluZWQgd2l0aFxuICAgICAgICAgIC8vIG9iamVjdHMgb3IgYXJyYXlzLCB3ZSBjYW4gY29uZmlkZW50bHkgcmV0dXJuIGFuIGVtcHR5IG9iamVjdCBhcyBpdFxuICAgICAgICAgIC8vIG5ldmVyIG1hdGNoZXMgYW55IHNjYWxhci5cbiAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cblxuICAgICAgICBmYWxsYmFjayA9IHRydWU7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0aGlzLl9zZWxlY3RvcltwYXRoXTtcbiAgICB9LFxuICAgIHggPT4geCk7XG5cbiAgaWYgKGZhbGxiYWNrKSB7XG4gICAgdGhpcy5fbWF0Y2hpbmdEb2N1bWVudCA9IG51bGw7XG4gIH1cblxuICByZXR1cm4gdGhpcy5fbWF0Y2hpbmdEb2N1bWVudDtcbn07XG5cbi8vIE1pbmltb25nby5Tb3J0ZXIgZ2V0cyBhIHNpbWlsYXIgbWV0aG9kLCB3aGljaCBkZWxlZ2F0ZXMgdG8gYSBNYXRjaGVyIGl0IG1hZGVcbi8vIGZvciB0aGlzIGV4YWN0IHB1cnBvc2UuXG5NaW5pbW9uZ28uU29ydGVyLnByb3RvdHlwZS5hZmZlY3RlZEJ5TW9kaWZpZXIgPSBmdW5jdGlvbihtb2RpZmllcikge1xuICByZXR1cm4gdGhpcy5fc2VsZWN0b3JGb3JBZmZlY3RlZEJ5TW9kaWZpZXIuYWZmZWN0ZWRCeU1vZGlmaWVyKG1vZGlmaWVyKTtcbn07XG5cbk1pbmltb25nby5Tb3J0ZXIucHJvdG90eXBlLmNvbWJpbmVJbnRvUHJvamVjdGlvbiA9IGZ1bmN0aW9uKHByb2plY3Rpb24pIHtcbiAgcmV0dXJuIGNvbWJpbmVJbXBvcnRhbnRQYXRoc0ludG9Qcm9qZWN0aW9uKFxuICAgIE1pbmltb25nby5fcGF0aHNFbGlkaW5nTnVtZXJpY0tleXModGhpcy5fZ2V0UGF0aHMoKSksXG4gICAgcHJvamVjdGlvblxuICApO1xufTtcblxuZnVuY3Rpb24gY29tYmluZUltcG9ydGFudFBhdGhzSW50b1Byb2plY3Rpb24ocGF0aHMsIHByb2plY3Rpb24pIHtcbiAgY29uc3QgZGV0YWlscyA9IHByb2plY3Rpb25EZXRhaWxzKHByb2plY3Rpb24pO1xuXG4gIC8vIG1lcmdlIHRoZSBwYXRocyB0byBpbmNsdWRlXG4gIGNvbnN0IHRyZWUgPSBwYXRoc1RvVHJlZShcbiAgICBwYXRocyxcbiAgICBwYXRoID0+IHRydWUsXG4gICAgKG5vZGUsIHBhdGgsIGZ1bGxQYXRoKSA9PiB0cnVlLFxuICAgIGRldGFpbHMudHJlZVxuICApO1xuICBjb25zdCBtZXJnZWRQcm9qZWN0aW9uID0gdHJlZVRvUGF0aHModHJlZSk7XG5cbiAgaWYgKGRldGFpbHMuaW5jbHVkaW5nKSB7XG4gICAgLy8gYm90aCBzZWxlY3RvciBhbmQgcHJvamVjdGlvbiBhcmUgcG9pbnRpbmcgb24gZmllbGRzIHRvIGluY2x1ZGVcbiAgICAvLyBzbyB3ZSBjYW4ganVzdCByZXR1cm4gdGhlIG1lcmdlZCB0cmVlXG4gICAgcmV0dXJuIG1lcmdlZFByb2plY3Rpb247XG4gIH1cblxuICAvLyBzZWxlY3RvciBpcyBwb2ludGluZyBhdCBmaWVsZHMgdG8gaW5jbHVkZVxuICAvLyBwcm9qZWN0aW9uIGlzIHBvaW50aW5nIGF0IGZpZWxkcyB0byBleGNsdWRlXG4gIC8vIG1ha2Ugc3VyZSB3ZSBkb24ndCBleGNsdWRlIGltcG9ydGFudCBwYXRoc1xuICBjb25zdCBtZXJnZWRFeGNsUHJvamVjdGlvbiA9IHt9O1xuXG4gIE9iamVjdC5rZXlzKG1lcmdlZFByb2plY3Rpb24pLmZvckVhY2gocGF0aCA9PiB7XG4gICAgaWYgKCFtZXJnZWRQcm9qZWN0aW9uW3BhdGhdKSB7XG4gICAgICBtZXJnZWRFeGNsUHJvamVjdGlvbltwYXRoXSA9IGZhbHNlO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIG1lcmdlZEV4Y2xQcm9qZWN0aW9uO1xufVxuXG5mdW5jdGlvbiBnZXRQYXRocyhzZWxlY3Rvcikge1xuICByZXR1cm4gT2JqZWN0LmtleXMobmV3IE1pbmltb25nby5NYXRjaGVyKHNlbGVjdG9yKS5fcGF0aHMpO1xuXG4gIC8vIFhYWCByZW1vdmUgaXQ/XG4gIC8vIHJldHVybiBPYmplY3Qua2V5cyhzZWxlY3RvcikubWFwKGsgPT4ge1xuICAvLyAgIC8vIHdlIGRvbid0IGtub3cgaG93IHRvIGhhbmRsZSAkd2hlcmUgYmVjYXVzZSBpdCBjYW4gYmUgYW55dGhpbmdcbiAgLy8gICBpZiAoayA9PT0gJyR3aGVyZScpIHtcbiAgLy8gICAgIHJldHVybiAnJzsgLy8gbWF0Y2hlcyBldmVyeXRoaW5nXG4gIC8vICAgfVxuXG4gIC8vICAgLy8gd2UgYnJhbmNoIGZyb20gJG9yLyRhbmQvJG5vciBvcGVyYXRvclxuICAvLyAgIGlmIChbJyRvcicsICckYW5kJywgJyRub3InXS5pbmNsdWRlcyhrKSkge1xuICAvLyAgICAgcmV0dXJuIHNlbGVjdG9yW2tdLm1hcChnZXRQYXRocyk7XG4gIC8vICAgfVxuXG4gIC8vICAgLy8gdGhlIHZhbHVlIGlzIGEgbGl0ZXJhbCBvciBzb21lIGNvbXBhcmlzb24gb3BlcmF0b3JcbiAgLy8gICByZXR1cm4gaztcbiAgLy8gfSlcbiAgLy8gICAucmVkdWNlKChhLCBiKSA9PiBhLmNvbmNhdChiKSwgW10pXG4gIC8vICAgLmZpbHRlcigoYSwgYiwgYykgPT4gYy5pbmRleE9mKGEpID09PSBiKTtcbn1cblxuLy8gQSBoZWxwZXIgdG8gZW5zdXJlIG9iamVjdCBoYXMgb25seSBjZXJ0YWluIGtleXNcbmZ1bmN0aW9uIG9ubHlDb250YWluc0tleXMob2JqLCBrZXlzKSB7XG4gIHJldHVybiBPYmplY3Qua2V5cyhvYmopLmV2ZXJ5KGsgPT4ga2V5cy5pbmNsdWRlcyhrKSk7XG59XG5cbmZ1bmN0aW9uIHBhdGhIYXNOdW1lcmljS2V5cyhwYXRoKSB7XG4gIHJldHVybiBwYXRoLnNwbGl0KCcuJykuc29tZShpc051bWVyaWNLZXkpO1xufVxuXG4vLyBSZXR1cm5zIGEgc2V0IG9mIGtleSBwYXRocyBzaW1pbGFyIHRvXG4vLyB7ICdmb28uYmFyJzogMSwgJ2EuYi5jJzogMSB9XG5mdW5jdGlvbiB0cmVlVG9QYXRocyh0cmVlLCBwcmVmaXggPSAnJykge1xuICBjb25zdCByZXN1bHQgPSB7fTtcblxuICBPYmplY3Qua2V5cyh0cmVlKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSB0cmVlW2tleV07XG4gICAgaWYgKHZhbHVlID09PSBPYmplY3QodmFsdWUpKSB7XG4gICAgICBPYmplY3QuYXNzaWduKHJlc3VsdCwgdHJlZVRvUGF0aHModmFsdWUsIGAke3ByZWZpeCArIGtleX0uYCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXN1bHRbcHJlZml4ICsga2V5XSA9IHZhbHVlO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cbiIsImltcG9ydCBMb2NhbENvbGxlY3Rpb24gZnJvbSAnLi9sb2NhbF9jb2xsZWN0aW9uLmpzJztcblxuZXhwb3J0IGNvbnN0IGhhc093biA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHk7XG5cbi8vIEVhY2ggZWxlbWVudCBzZWxlY3RvciBjb250YWluczpcbi8vICAtIGNvbXBpbGVFbGVtZW50U2VsZWN0b3IsIGEgZnVuY3Rpb24gd2l0aCBhcmdzOlxuLy8gICAgLSBvcGVyYW5kIC0gdGhlIFwicmlnaHQgaGFuZCBzaWRlXCIgb2YgdGhlIG9wZXJhdG9yXG4vLyAgICAtIHZhbHVlU2VsZWN0b3IgLSB0aGUgXCJjb250ZXh0XCIgZm9yIHRoZSBvcGVyYXRvciAoc28gdGhhdCAkcmVnZXggY2FuIGZpbmRcbi8vICAgICAgJG9wdGlvbnMpXG4vLyAgICAtIG1hdGNoZXIgLSB0aGUgTWF0Y2hlciB0aGlzIGlzIGdvaW5nIGludG8gKHNvIHRoYXQgJGVsZW1NYXRjaCBjYW4gY29tcGlsZVxuLy8gICAgICBtb3JlIHRoaW5ncylcbi8vICAgIHJldHVybmluZyBhIGZ1bmN0aW9uIG1hcHBpbmcgYSBzaW5nbGUgdmFsdWUgdG8gYm9vbC5cbi8vICAtIGRvbnRFeHBhbmRMZWFmQXJyYXlzLCBhIGJvb2wgd2hpY2ggcHJldmVudHMgZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyBmcm9tXG4vLyAgICBiZWluZyBjYWxsZWRcbi8vICAtIGRvbnRJbmNsdWRlTGVhZkFycmF5cywgYSBib29sIHdoaWNoIGNhdXNlcyBhbiBhcmd1bWVudCB0byBiZSBwYXNzZWQgdG9cbi8vICAgIGV4cGFuZEFycmF5c0luQnJhbmNoZXMgaWYgaXQgaXMgY2FsbGVkXG5leHBvcnQgY29uc3QgRUxFTUVOVF9PUEVSQVRPUlMgPSB7XG4gICRsdDogbWFrZUluZXF1YWxpdHkoY21wVmFsdWUgPT4gY21wVmFsdWUgPCAwKSxcbiAgJGd0OiBtYWtlSW5lcXVhbGl0eShjbXBWYWx1ZSA9PiBjbXBWYWx1ZSA+IDApLFxuICAkbHRlOiBtYWtlSW5lcXVhbGl0eShjbXBWYWx1ZSA9PiBjbXBWYWx1ZSA8PSAwKSxcbiAgJGd0ZTogbWFrZUluZXF1YWxpdHkoY21wVmFsdWUgPT4gY21wVmFsdWUgPj0gMCksXG4gICRtb2Q6IHtcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGlmICghKEFycmF5LmlzQXJyYXkob3BlcmFuZCkgJiYgb3BlcmFuZC5sZW5ndGggPT09IDJcbiAgICAgICAgICAgICYmIHR5cGVvZiBvcGVyYW5kWzBdID09PSAnbnVtYmVyJ1xuICAgICAgICAgICAgJiYgdHlwZW9mIG9wZXJhbmRbMV0gPT09ICdudW1iZXInKSkge1xuICAgICAgICB0aHJvdyBFcnJvcignYXJndW1lbnQgdG8gJG1vZCBtdXN0IGJlIGFuIGFycmF5IG9mIHR3byBudW1iZXJzJyk7XG4gICAgICB9XG5cbiAgICAgIC8vIFhYWCBjb3VsZCByZXF1aXJlIHRvIGJlIGludHMgb3Igcm91bmQgb3Igc29tZXRoaW5nXG4gICAgICBjb25zdCBkaXZpc29yID0gb3BlcmFuZFswXTtcbiAgICAgIGNvbnN0IHJlbWFpbmRlciA9IG9wZXJhbmRbMV07XG4gICAgICByZXR1cm4gdmFsdWUgPT4gKFxuICAgICAgICB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInICYmIHZhbHVlICUgZGl2aXNvciA9PT0gcmVtYWluZGVyXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gICRpbjoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KG9wZXJhbmQpKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckaW4gbmVlZHMgYW4gYXJyYXknKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZWxlbWVudE1hdGNoZXJzID0gb3BlcmFuZC5tYXAob3B0aW9uID0+IHtcbiAgICAgICAgaWYgKG9wdGlvbiBpbnN0YW5jZW9mIFJlZ0V4cCkge1xuICAgICAgICAgIHJldHVybiByZWdleHBFbGVtZW50TWF0Y2hlcihvcHRpb24pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGlzT3BlcmF0b3JPYmplY3Qob3B0aW9uKSkge1xuICAgICAgICAgIHRocm93IEVycm9yKCdjYW5ub3QgbmVzdCAkIHVuZGVyICRpbicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGVxdWFsaXR5RWxlbWVudE1hdGNoZXIob3B0aW9uKTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICAvLyBBbGxvdyB7YTogeyRpbjogW251bGxdfX0gdG8gbWF0Y2ggd2hlbiAnYScgZG9lcyBub3QgZXhpc3QuXG4gICAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgdmFsdWUgPSBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGVsZW1lbnRNYXRjaGVycy5zb21lKG1hdGNoZXIgPT4gbWF0Y2hlcih2YWx1ZSkpO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICAkc2l6ZToge1xuICAgIC8vIHthOiBbWzUsIDVdXX0gbXVzdCBtYXRjaCB7YTogeyRzaXplOiAxfX0gYnV0IG5vdCB7YTogeyRzaXplOiAyfX0sIHNvIHdlXG4gICAgLy8gZG9uJ3Qgd2FudCB0byBjb25zaWRlciB0aGUgZWxlbWVudCBbNSw1XSBpbiB0aGUgbGVhZiBhcnJheSBbWzUsNV1dIGFzIGFcbiAgICAvLyBwb3NzaWJsZSB2YWx1ZS5cbiAgICBkb250RXhwYW5kTGVhZkFycmF5czogdHJ1ZSxcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGlmICh0eXBlb2Ygb3BlcmFuZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgLy8gRG9uJ3QgYXNrIG1lIHdoeSwgYnV0IGJ5IGV4cGVyaW1lbnRhdGlvbiwgdGhpcyBzZWVtcyB0byBiZSB3aGF0IE1vbmdvXG4gICAgICAgIC8vIGRvZXMuXG4gICAgICAgIG9wZXJhbmQgPSAwO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2Ygb3BlcmFuZCAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJyRzaXplIG5lZWRzIGEgbnVtYmVyJyk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB2YWx1ZSA9PiBBcnJheS5pc0FycmF5KHZhbHVlKSAmJiB2YWx1ZS5sZW5ndGggPT09IG9wZXJhbmQ7XG4gICAgfSxcbiAgfSxcbiAgJHR5cGU6IHtcbiAgICAvLyB7YTogWzVdfSBtdXN0IG5vdCBtYXRjaCB7YTogeyR0eXBlOiA0fX0gKDQgbWVhbnMgYXJyYXkpLCBidXQgaXQgc2hvdWxkXG4gICAgLy8gbWF0Y2gge2E6IHskdHlwZTogMX19ICgxIG1lYW5zIG51bWJlciksIGFuZCB7YTogW1s1XV19IG11c3QgbWF0Y2ggeyRhOlxuICAgIC8vIHskdHlwZTogNH19LiBUaHVzLCB3aGVuIHdlIHNlZSBhIGxlYWYgYXJyYXksIHdlICpzaG91bGQqIGV4cGFuZCBpdCBidXRcbiAgICAvLyBzaG91bGQgKm5vdCogaW5jbHVkZSBpdCBpdHNlbGYuXG4gICAgZG9udEluY2x1ZGVMZWFmQXJyYXlzOiB0cnVlLFxuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgaWYgKHR5cGVvZiBvcGVyYW5kID09PSAnc3RyaW5nJykge1xuICAgICAgICBjb25zdCBvcGVyYW5kQWxpYXNNYXAgPSB7XG4gICAgICAgICAgJ2RvdWJsZSc6IDEsXG4gICAgICAgICAgJ3N0cmluZyc6IDIsXG4gICAgICAgICAgJ29iamVjdCc6IDMsXG4gICAgICAgICAgJ2FycmF5JzogNCxcbiAgICAgICAgICAnYmluRGF0YSc6IDUsXG4gICAgICAgICAgJ3VuZGVmaW5lZCc6IDYsXG4gICAgICAgICAgJ29iamVjdElkJzogNyxcbiAgICAgICAgICAnYm9vbCc6IDgsXG4gICAgICAgICAgJ2RhdGUnOiA5LFxuICAgICAgICAgICdudWxsJzogMTAsXG4gICAgICAgICAgJ3JlZ2V4JzogMTEsXG4gICAgICAgICAgJ2RiUG9pbnRlcic6IDEyLFxuICAgICAgICAgICdqYXZhc2NyaXB0JzogMTMsXG4gICAgICAgICAgJ3N5bWJvbCc6IDE0LFxuICAgICAgICAgICdqYXZhc2NyaXB0V2l0aFNjb3BlJzogMTUsXG4gICAgICAgICAgJ2ludCc6IDE2LFxuICAgICAgICAgICd0aW1lc3RhbXAnOiAxNyxcbiAgICAgICAgICAnbG9uZyc6IDE4LFxuICAgICAgICAgICdkZWNpbWFsJzogMTksXG4gICAgICAgICAgJ21pbktleSc6IC0xLFxuICAgICAgICAgICdtYXhLZXknOiAxMjcsXG4gICAgICAgIH07XG4gICAgICAgIGlmICghaGFzT3duLmNhbGwob3BlcmFuZEFsaWFzTWFwLCBvcGVyYW5kKSkge1xuICAgICAgICAgIHRocm93IEVycm9yKGB1bmtub3duIHN0cmluZyBhbGlhcyBmb3IgJHR5cGU6ICR7b3BlcmFuZH1gKTtcbiAgICAgICAgfVxuICAgICAgICBvcGVyYW5kID0gb3BlcmFuZEFsaWFzTWFwW29wZXJhbmRdO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2Ygb3BlcmFuZCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgaWYgKG9wZXJhbmQgPT09IDAgfHwgb3BlcmFuZCA8IC0xXG4gICAgICAgICAgfHwgKG9wZXJhbmQgPiAxOSAmJiBvcGVyYW5kICE9PSAxMjcpKSB7XG4gICAgICAgICAgdGhyb3cgRXJyb3IoYEludmFsaWQgbnVtZXJpY2FsICR0eXBlIGNvZGU6ICR7b3BlcmFuZH1gKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ2FyZ3VtZW50IHRvICR0eXBlIGlzIG5vdCBhIG51bWJlciBvciBhIHN0cmluZycpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdmFsdWUgPT4gKFxuICAgICAgICB2YWx1ZSAhPT0gdW5kZWZpbmVkICYmIExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZSh2YWx1ZSkgPT09IG9wZXJhbmRcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAgJGJpdHNBbGxTZXQ6IHtcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGNvbnN0IG1hc2sgPSBnZXRPcGVyYW5kQml0bWFzayhvcGVyYW5kLCAnJGJpdHNBbGxTZXQnKTtcbiAgICAgIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgICAgIGNvbnN0IGJpdG1hc2sgPSBnZXRWYWx1ZUJpdG1hc2sodmFsdWUsIG1hc2subGVuZ3RoKTtcbiAgICAgICAgcmV0dXJuIGJpdG1hc2sgJiYgbWFzay5ldmVyeSgoYnl0ZSwgaSkgPT4gKGJpdG1hc2tbaV0gJiBieXRlKSA9PT0gYnl0ZSk7XG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gICRiaXRzQW55U2V0OiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBjb25zdCBtYXNrID0gZ2V0T3BlcmFuZEJpdG1hc2sob3BlcmFuZCwgJyRiaXRzQW55U2V0Jyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suc29tZSgoYnl0ZSwgaSkgPT4gKH5iaXRtYXNrW2ldICYgYnl0ZSkgIT09IGJ5dGUpO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICAkYml0c0FsbENsZWFyOiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBjb25zdCBtYXNrID0gZ2V0T3BlcmFuZEJpdG1hc2sob3BlcmFuZCwgJyRiaXRzQWxsQ2xlYXInKTtcbiAgICAgIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgICAgIGNvbnN0IGJpdG1hc2sgPSBnZXRWYWx1ZUJpdG1hc2sodmFsdWUsIG1hc2subGVuZ3RoKTtcbiAgICAgICAgcmV0dXJuIGJpdG1hc2sgJiYgbWFzay5ldmVyeSgoYnl0ZSwgaSkgPT4gIShiaXRtYXNrW2ldICYgYnl0ZSkpO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICAkYml0c0FueUNsZWFyOiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBjb25zdCBtYXNrID0gZ2V0T3BlcmFuZEJpdG1hc2sob3BlcmFuZCwgJyRiaXRzQW55Q2xlYXInKTtcbiAgICAgIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgICAgIGNvbnN0IGJpdG1hc2sgPSBnZXRWYWx1ZUJpdG1hc2sodmFsdWUsIG1hc2subGVuZ3RoKTtcbiAgICAgICAgcmV0dXJuIGJpdG1hc2sgJiYgbWFzay5zb21lKChieXRlLCBpKSA9PiAoYml0bWFza1tpXSAmIGJ5dGUpICE9PSBieXRlKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJHJlZ2V4OiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yKSB7XG4gICAgICBpZiAoISh0eXBlb2Ygb3BlcmFuZCA9PT0gJ3N0cmluZycgfHwgb3BlcmFuZCBpbnN0YW5jZW9mIFJlZ0V4cCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJyRyZWdleCBoYXMgdG8gYmUgYSBzdHJpbmcgb3IgUmVnRXhwJyk7XG4gICAgICB9XG5cbiAgICAgIGxldCByZWdleHA7XG4gICAgICBpZiAodmFsdWVTZWxlY3Rvci4kb3B0aW9ucyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIC8vIE9wdGlvbnMgcGFzc2VkIGluICRvcHRpb25zIChldmVuIHRoZSBlbXB0eSBzdHJpbmcpIGFsd2F5cyBvdmVycmlkZXNcbiAgICAgICAgLy8gb3B0aW9ucyBpbiB0aGUgUmVnRXhwIG9iamVjdCBpdHNlbGYuXG5cbiAgICAgICAgLy8gQmUgY2xlYXIgdGhhdCB3ZSBvbmx5IHN1cHBvcnQgdGhlIEpTLXN1cHBvcnRlZCBvcHRpb25zLCBub3QgZXh0ZW5kZWRcbiAgICAgICAgLy8gb25lcyAoZWcsIE1vbmdvIHN1cHBvcnRzIHggYW5kIHMpLiBJZGVhbGx5IHdlIHdvdWxkIGltcGxlbWVudCB4IGFuZCBzXG4gICAgICAgIC8vIGJ5IHRyYW5zZm9ybWluZyB0aGUgcmVnZXhwLCBidXQgbm90IHRvZGF5Li4uXG4gICAgICAgIGlmICgvW15naW1dLy50ZXN0KHZhbHVlU2VsZWN0b3IuJG9wdGlvbnMpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IHRoZSBpLCBtLCBhbmQgZyByZWdleHAgb3B0aW9ucyBhcmUgc3VwcG9ydGVkJyk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBzb3VyY2UgPSBvcGVyYW5kIGluc3RhbmNlb2YgUmVnRXhwID8gb3BlcmFuZC5zb3VyY2UgOiBvcGVyYW5kO1xuICAgICAgICByZWdleHAgPSBuZXcgUmVnRXhwKHNvdXJjZSwgdmFsdWVTZWxlY3Rvci4kb3B0aW9ucyk7XG4gICAgICB9IGVsc2UgaWYgKG9wZXJhbmQgaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICAgICAgcmVnZXhwID0gb3BlcmFuZDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlZ2V4cCA9IG5ldyBSZWdFeHAob3BlcmFuZCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZWdleHBFbGVtZW50TWF0Y2hlcihyZWdleHApO1xuICAgIH0sXG4gIH0sXG4gICRlbGVtTWF0Y2g6IHtcbiAgICBkb250RXhwYW5kTGVhZkFycmF5czogdHJ1ZSxcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIpIHtcbiAgICAgIGlmICghTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KG9wZXJhbmQpKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckZWxlbU1hdGNoIG5lZWQgYW4gb2JqZWN0Jyk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGlzRG9jTWF0Y2hlciA9ICFpc09wZXJhdG9yT2JqZWN0KFxuICAgICAgICBPYmplY3Qua2V5cyhvcGVyYW5kKVxuICAgICAgICAgIC5maWx0ZXIoa2V5ID0+ICFoYXNPd24uY2FsbChMT0dJQ0FMX09QRVJBVE9SUywga2V5KSlcbiAgICAgICAgICAucmVkdWNlKChhLCBiKSA9PiBPYmplY3QuYXNzaWduKGEsIHtbYl06IG9wZXJhbmRbYl19KSwge30pLFxuICAgICAgICB0cnVlKTtcblxuICAgICAgbGV0IHN1Yk1hdGNoZXI7XG4gICAgICBpZiAoaXNEb2NNYXRjaGVyKSB7XG4gICAgICAgIC8vIFRoaXMgaXMgTk9UIHRoZSBzYW1lIGFzIGNvbXBpbGVWYWx1ZVNlbGVjdG9yKG9wZXJhbmQpLCBhbmQgbm90IGp1c3RcbiAgICAgICAgLy8gYmVjYXVzZSBvZiB0aGUgc2xpZ2h0bHkgZGlmZmVyZW50IGNhbGxpbmcgY29udmVudGlvbi5cbiAgICAgICAgLy8geyRlbGVtTWF0Y2g6IHt4OiAzfX0gbWVhbnMgXCJhbiBlbGVtZW50IGhhcyBhIGZpZWxkIHg6M1wiLCBub3RcbiAgICAgICAgLy8gXCJjb25zaXN0cyBvbmx5IG9mIGEgZmllbGQgeDozXCIuIEFsc28sIHJlZ2V4cHMgYW5kIHN1Yi0kIGFyZSBhbGxvd2VkLlxuICAgICAgICBzdWJNYXRjaGVyID1cbiAgICAgICAgICBjb21waWxlRG9jdW1lbnRTZWxlY3RvcihvcGVyYW5kLCBtYXRjaGVyLCB7aW5FbGVtTWF0Y2g6IHRydWV9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN1Yk1hdGNoZXIgPSBjb21waWxlVmFsdWVTZWxlY3RvcihvcGVyYW5kLCBtYXRjaGVyKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyArK2kpIHtcbiAgICAgICAgICBjb25zdCBhcnJheUVsZW1lbnQgPSB2YWx1ZVtpXTtcbiAgICAgICAgICBsZXQgYXJnO1xuICAgICAgICAgIGlmIChpc0RvY01hdGNoZXIpIHtcbiAgICAgICAgICAgIC8vIFdlIGNhbiBvbmx5IG1hdGNoIHskZWxlbU1hdGNoOiB7YjogM319IGFnYWluc3Qgb2JqZWN0cy5cbiAgICAgICAgICAgIC8vIChXZSBjYW4gYWxzbyBtYXRjaCBhZ2FpbnN0IGFycmF5cywgaWYgdGhlcmUncyBudW1lcmljIGluZGljZXMsXG4gICAgICAgICAgICAvLyBlZyB7JGVsZW1NYXRjaDogeycwLmInOiAzfX0gb3IgeyRlbGVtTWF0Y2g6IHswOiAzfX0uKVxuICAgICAgICAgICAgaWYgKCFpc0luZGV4YWJsZShhcnJheUVsZW1lbnQpKSB7XG4gICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXJnID0gYXJyYXlFbGVtZW50O1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBkb250SXRlcmF0ZSBlbnN1cmVzIHRoYXQge2E6IHskZWxlbU1hdGNoOiB7JGd0OiA1fX19IG1hdGNoZXNcbiAgICAgICAgICAgIC8vIHthOiBbOF19IGJ1dCBub3Qge2E6IFtbOF1dfVxuICAgICAgICAgICAgYXJnID0gW3t2YWx1ZTogYXJyYXlFbGVtZW50LCBkb250SXRlcmF0ZTogdHJ1ZX1dO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBYWFggc3VwcG9ydCAkbmVhciBpbiAkZWxlbU1hdGNoIGJ5IHByb3BhZ2F0aW5nICRkaXN0YW5jZT9cbiAgICAgICAgICBpZiAoc3ViTWF0Y2hlcihhcmcpLnJlc3VsdCkge1xuICAgICAgICAgICAgcmV0dXJuIGk7IC8vIHNwZWNpYWxseSB1bmRlcnN0b29kIHRvIG1lYW4gXCJ1c2UgYXMgYXJyYXlJbmRpY2VzXCJcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG59O1xuXG4vLyBPcGVyYXRvcnMgdGhhdCBhcHBlYXIgYXQgdGhlIHRvcCBsZXZlbCBvZiBhIGRvY3VtZW50IHNlbGVjdG9yLlxuY29uc3QgTE9HSUNBTF9PUEVSQVRPUlMgPSB7XG4gICRhbmQoc3ViU2VsZWN0b3IsIG1hdGNoZXIsIGluRWxlbU1hdGNoKSB7XG4gICAgcmV0dXJuIGFuZERvY3VtZW50TWF0Y2hlcnMoXG4gICAgICBjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzKHN1YlNlbGVjdG9yLCBtYXRjaGVyLCBpbkVsZW1NYXRjaClcbiAgICApO1xuICB9LFxuXG4gICRvcihzdWJTZWxlY3RvciwgbWF0Y2hlciwgaW5FbGVtTWF0Y2gpIHtcbiAgICBjb25zdCBtYXRjaGVycyA9IGNvbXBpbGVBcnJheU9mRG9jdW1lbnRTZWxlY3RvcnMoXG4gICAgICBzdWJTZWxlY3RvcixcbiAgICAgIG1hdGNoZXIsXG4gICAgICBpbkVsZW1NYXRjaFxuICAgICk7XG5cbiAgICAvLyBTcGVjaWFsIGNhc2U6IGlmIHRoZXJlIGlzIG9ubHkgb25lIG1hdGNoZXIsIHVzZSBpdCBkaXJlY3RseSwgKnByZXNlcnZpbmcqXG4gICAgLy8gYW55IGFycmF5SW5kaWNlcyBpdCByZXR1cm5zLlxuICAgIGlmIChtYXRjaGVycy5sZW5ndGggPT09IDEpIHtcbiAgICAgIHJldHVybiBtYXRjaGVyc1swXTtcbiAgICB9XG5cbiAgICByZXR1cm4gZG9jID0+IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IG1hdGNoZXJzLnNvbWUoZm4gPT4gZm4oZG9jKS5yZXN1bHQpO1xuICAgICAgLy8gJG9yIGRvZXMgTk9UIHNldCBhcnJheUluZGljZXMgd2hlbiBpdCBoYXMgbXVsdGlwbGVcbiAgICAgIC8vIHN1Yi1leHByZXNzaW9ucy4gKFRlc3RlZCBhZ2FpbnN0IE1vbmdvREIuKVxuICAgICAgcmV0dXJuIHtyZXN1bHR9O1xuICAgIH07XG4gIH0sXG5cbiAgJG5vcihzdWJTZWxlY3RvciwgbWF0Y2hlciwgaW5FbGVtTWF0Y2gpIHtcbiAgICBjb25zdCBtYXRjaGVycyA9IGNvbXBpbGVBcnJheU9mRG9jdW1lbnRTZWxlY3RvcnMoXG4gICAgICBzdWJTZWxlY3RvcixcbiAgICAgIG1hdGNoZXIsXG4gICAgICBpbkVsZW1NYXRjaFxuICAgICk7XG4gICAgcmV0dXJuIGRvYyA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBtYXRjaGVycy5ldmVyeShmbiA9PiAhZm4oZG9jKS5yZXN1bHQpO1xuICAgICAgLy8gTmV2ZXIgc2V0IGFycmF5SW5kaWNlcywgYmVjYXVzZSB3ZSBvbmx5IG1hdGNoIGlmIG5vdGhpbmcgaW4gcGFydGljdWxhclxuICAgICAgLy8gJ21hdGNoZWQnIChhbmQgYmVjYXVzZSB0aGlzIGlzIGNvbnNpc3RlbnQgd2l0aCBNb25nb0RCKS5cbiAgICAgIHJldHVybiB7cmVzdWx0fTtcbiAgICB9O1xuICB9LFxuXG4gICR3aGVyZShzZWxlY3RvclZhbHVlLCBtYXRjaGVyKSB7XG4gICAgLy8gUmVjb3JkIHRoYXQgKmFueSogcGF0aCBtYXkgYmUgdXNlZC5cbiAgICBtYXRjaGVyLl9yZWNvcmRQYXRoVXNlZCgnJyk7XG4gICAgbWF0Y2hlci5faGFzV2hlcmUgPSB0cnVlO1xuXG4gICAgaWYgKCEoc2VsZWN0b3JWYWx1ZSBpbnN0YW5jZW9mIEZ1bmN0aW9uKSkge1xuICAgICAgLy8gWFhYIE1vbmdvREIgc2VlbXMgdG8gaGF2ZSBtb3JlIGNvbXBsZXggbG9naWMgdG8gZGVjaWRlIHdoZXJlIG9yIG9yIG5vdFxuICAgICAgLy8gdG8gYWRkICdyZXR1cm4nOyBub3Qgc3VyZSBleGFjdGx5IHdoYXQgaXQgaXMuXG4gICAgICBzZWxlY3RvclZhbHVlID0gRnVuY3Rpb24oJ29iaicsIGByZXR1cm4gJHtzZWxlY3RvclZhbHVlfWApO1xuICAgIH1cblxuICAgIC8vIFdlIG1ha2UgdGhlIGRvY3VtZW50IGF2YWlsYWJsZSBhcyBib3RoIGB0aGlzYCBhbmQgYG9iamAuXG4gICAgLy8gLy8gWFhYIG5vdCBzdXJlIHdoYXQgd2Ugc2hvdWxkIGRvIGlmIHRoaXMgdGhyb3dzXG4gICAgcmV0dXJuIGRvYyA9PiAoe3Jlc3VsdDogc2VsZWN0b3JWYWx1ZS5jYWxsKGRvYywgZG9jKX0pO1xuICB9LFxuXG4gIC8vIFRoaXMgaXMganVzdCB1c2VkIGFzIGEgY29tbWVudCBpbiB0aGUgcXVlcnkgKGluIE1vbmdvREIsIGl0IGFsc28gZW5kcyB1cCBpblxuICAvLyBxdWVyeSBsb2dzKTsgaXQgaGFzIG5vIGVmZmVjdCBvbiB0aGUgYWN0dWFsIHNlbGVjdGlvbi5cbiAgJGNvbW1lbnQoKSB7XG4gICAgcmV0dXJuICgpID0+ICh7cmVzdWx0OiB0cnVlfSk7XG4gIH0sXG59O1xuXG4vLyBPcGVyYXRvcnMgdGhhdCAodW5saWtlIExPR0lDQUxfT1BFUkFUT1JTKSBwZXJ0YWluIHRvIGluZGl2aWR1YWwgcGF0aHMgaW4gYVxuLy8gZG9jdW1lbnQsIGJ1dCAodW5saWtlIEVMRU1FTlRfT1BFUkFUT1JTKSBkbyBub3QgaGF2ZSBhIHNpbXBsZSBkZWZpbml0aW9uIGFzXG4vLyBcIm1hdGNoIGVhY2ggYnJhbmNoZWQgdmFsdWUgaW5kZXBlbmRlbnRseSBhbmQgY29tYmluZSB3aXRoXG4vLyBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlclwiLlxuY29uc3QgVkFMVUVfT1BFUkFUT1JTID0ge1xuICAkZXEob3BlcmFuZCkge1xuICAgIHJldHVybiBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlcihcbiAgICAgIGVxdWFsaXR5RWxlbWVudE1hdGNoZXIob3BlcmFuZClcbiAgICApO1xuICB9LFxuICAkbm90KG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIpIHtcbiAgICByZXR1cm4gaW52ZXJ0QnJhbmNoZWRNYXRjaGVyKGNvbXBpbGVWYWx1ZVNlbGVjdG9yKG9wZXJhbmQsIG1hdGNoZXIpKTtcbiAgfSxcbiAgJG5lKG9wZXJhbmQpIHtcbiAgICByZXR1cm4gaW52ZXJ0QnJhbmNoZWRNYXRjaGVyKFxuICAgICAgY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoZXF1YWxpdHlFbGVtZW50TWF0Y2hlcihvcGVyYW5kKSlcbiAgICApO1xuICB9LFxuICAkbmluKG9wZXJhbmQpIHtcbiAgICByZXR1cm4gaW52ZXJ0QnJhbmNoZWRNYXRjaGVyKFxuICAgICAgY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICAgIEVMRU1FTlRfT1BFUkFUT1JTLiRpbi5jb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpXG4gICAgICApXG4gICAgKTtcbiAgfSxcbiAgJGV4aXN0cyhvcGVyYW5kKSB7XG4gICAgY29uc3QgZXhpc3RzID0gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICB2YWx1ZSA9PiB2YWx1ZSAhPT0gdW5kZWZpbmVkXG4gICAgKTtcbiAgICByZXR1cm4gb3BlcmFuZCA/IGV4aXN0cyA6IGludmVydEJyYW5jaGVkTWF0Y2hlcihleGlzdHMpO1xuICB9LFxuICAvLyAkb3B0aW9ucyBqdXN0IHByb3ZpZGVzIG9wdGlvbnMgZm9yICRyZWdleDsgaXRzIGxvZ2ljIGlzIGluc2lkZSAkcmVnZXhcbiAgJG9wdGlvbnMob3BlcmFuZCwgdmFsdWVTZWxlY3Rvcikge1xuICAgIGlmICghaGFzT3duLmNhbGwodmFsdWVTZWxlY3RvciwgJyRyZWdleCcpKSB7XG4gICAgICB0aHJvdyBFcnJvcignJG9wdGlvbnMgbmVlZHMgYSAkcmVnZXgnKTtcbiAgICB9XG5cbiAgICByZXR1cm4gZXZlcnl0aGluZ01hdGNoZXI7XG4gIH0sXG4gIC8vICRtYXhEaXN0YW5jZSBpcyBiYXNpY2FsbHkgYW4gYXJndW1lbnQgdG8gJG5lYXJcbiAgJG1heERpc3RhbmNlKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IpIHtcbiAgICBpZiAoIXZhbHVlU2VsZWN0b3IuJG5lYXIpIHtcbiAgICAgIHRocm93IEVycm9yKCckbWF4RGlzdGFuY2UgbmVlZHMgYSAkbmVhcicpO1xuICAgIH1cblxuICAgIHJldHVybiBldmVyeXRoaW5nTWF0Y2hlcjtcbiAgfSxcbiAgJGFsbChvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyKSB7XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KG9wZXJhbmQpKSB7XG4gICAgICB0aHJvdyBFcnJvcignJGFsbCByZXF1aXJlcyBhcnJheScpO1xuICAgIH1cblxuICAgIC8vIE5vdCBzdXJlIHdoeSwgYnV0IHRoaXMgc2VlbXMgdG8gYmUgd2hhdCBNb25nb0RCIGRvZXMuXG4gICAgaWYgKG9wZXJhbmQubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4gbm90aGluZ01hdGNoZXI7XG4gICAgfVxuXG4gICAgY29uc3QgYnJhbmNoZWRNYXRjaGVycyA9IG9wZXJhbmQubWFwKGNyaXRlcmlvbiA9PiB7XG4gICAgICAvLyBYWFggaGFuZGxlICRhbGwvJGVsZW1NYXRjaCBjb21iaW5hdGlvblxuICAgICAgaWYgKGlzT3BlcmF0b3JPYmplY3QoY3JpdGVyaW9uKSkge1xuICAgICAgICB0aHJvdyBFcnJvcignbm8gJCBleHByZXNzaW9ucyBpbiAkYWxsJyk7XG4gICAgICB9XG5cbiAgICAgIC8vIFRoaXMgaXMgYWx3YXlzIGEgcmVnZXhwIG9yIGVxdWFsaXR5IHNlbGVjdG9yLlxuICAgICAgcmV0dXJuIGNvbXBpbGVWYWx1ZVNlbGVjdG9yKGNyaXRlcmlvbiwgbWF0Y2hlcik7XG4gICAgfSk7XG5cbiAgICAvLyBhbmRCcmFuY2hlZE1hdGNoZXJzIGRvZXMgTk9UIHJlcXVpcmUgYWxsIHNlbGVjdG9ycyB0byByZXR1cm4gdHJ1ZSBvbiB0aGVcbiAgICAvLyBTQU1FIGJyYW5jaC5cbiAgICByZXR1cm4gYW5kQnJhbmNoZWRNYXRjaGVycyhicmFuY2hlZE1hdGNoZXJzKTtcbiAgfSxcbiAgJG5lYXIob3BlcmFuZCwgdmFsdWVTZWxlY3RvciwgbWF0Y2hlciwgaXNSb290KSB7XG4gICAgaWYgKCFpc1Jvb3QpIHtcbiAgICAgIHRocm93IEVycm9yKCckbmVhciBjYW5cXCd0IGJlIGluc2lkZSBhbm90aGVyICQgb3BlcmF0b3InKTtcbiAgICB9XG5cbiAgICBtYXRjaGVyLl9oYXNHZW9RdWVyeSA9IHRydWU7XG5cbiAgICAvLyBUaGVyZSBhcmUgdHdvIGtpbmRzIG9mIGdlb2RhdGEgaW4gTW9uZ29EQjogbGVnYWN5IGNvb3JkaW5hdGUgcGFpcnMgYW5kXG4gICAgLy8gR2VvSlNPTi4gVGhleSB1c2UgZGlmZmVyZW50IGRpc3RhbmNlIG1ldHJpY3MsIHRvby4gR2VvSlNPTiBxdWVyaWVzIGFyZVxuICAgIC8vIG1hcmtlZCB3aXRoIGEgJGdlb21ldHJ5IHByb3BlcnR5LCB0aG91Z2ggbGVnYWN5IGNvb3JkaW5hdGVzIGNhbiBiZVxuICAgIC8vIG1hdGNoZWQgdXNpbmcgJGdlb21ldHJ5LlxuICAgIGxldCBtYXhEaXN0YW5jZSwgcG9pbnQsIGRpc3RhbmNlO1xuICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3Qob3BlcmFuZCkgJiYgaGFzT3duLmNhbGwob3BlcmFuZCwgJyRnZW9tZXRyeScpKSB7XG4gICAgICAvLyBHZW9KU09OIFwiMmRzcGhlcmVcIiBtb2RlLlxuICAgICAgbWF4RGlzdGFuY2UgPSBvcGVyYW5kLiRtYXhEaXN0YW5jZTtcbiAgICAgIHBvaW50ID0gb3BlcmFuZC4kZ2VvbWV0cnk7XG4gICAgICBkaXN0YW5jZSA9IHZhbHVlID0+IHtcbiAgICAgICAgLy8gWFhYOiBmb3Igbm93LCB3ZSBkb24ndCBjYWxjdWxhdGUgdGhlIGFjdHVhbCBkaXN0YW5jZSBiZXR3ZWVuLCBzYXksXG4gICAgICAgIC8vIHBvbHlnb24gYW5kIGNpcmNsZS4gSWYgcGVvcGxlIGNhcmUgYWJvdXQgdGhpcyB1c2UtY2FzZSBpdCB3aWxsIGdldFxuICAgICAgICAvLyBhIHByaW9yaXR5LlxuICAgICAgICBpZiAoIXZhbHVlKSB7XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXZhbHVlLnR5cGUpIHtcbiAgICAgICAgICByZXR1cm4gR2VvSlNPTi5wb2ludERpc3RhbmNlKFxuICAgICAgICAgICAgcG9pbnQsXG4gICAgICAgICAgICB7dHlwZTogJ1BvaW50JywgY29vcmRpbmF0ZXM6IHBvaW50VG9BcnJheSh2YWx1ZSl9XG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh2YWx1ZS50eXBlID09PSAnUG9pbnQnKSB7XG4gICAgICAgICAgcmV0dXJuIEdlb0pTT04ucG9pbnREaXN0YW5jZShwb2ludCwgdmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIEdlb0pTT04uZ2VvbWV0cnlXaXRoaW5SYWRpdXModmFsdWUsIHBvaW50LCBtYXhEaXN0YW5jZSlcbiAgICAgICAgICA/IDBcbiAgICAgICAgICA6IG1heERpc3RhbmNlICsgMTtcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIG1heERpc3RhbmNlID0gdmFsdWVTZWxlY3Rvci4kbWF4RGlzdGFuY2U7XG5cbiAgICAgIGlmICghaXNJbmRleGFibGUob3BlcmFuZCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJyRuZWFyIGFyZ3VtZW50IG11c3QgYmUgY29vcmRpbmF0ZSBwYWlyIG9yIEdlb0pTT04nKTtcbiAgICAgIH1cblxuICAgICAgcG9pbnQgPSBwb2ludFRvQXJyYXkob3BlcmFuZCk7XG5cbiAgICAgIGRpc3RhbmNlID0gdmFsdWUgPT4ge1xuICAgICAgICBpZiAoIWlzSW5kZXhhYmxlKHZhbHVlKSkge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGRpc3RhbmNlQ29vcmRpbmF0ZVBhaXJzKHBvaW50LCB2YWx1ZSk7XG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBicmFuY2hlZFZhbHVlcyA9PiB7XG4gICAgICAvLyBUaGVyZSBtaWdodCBiZSBtdWx0aXBsZSBwb2ludHMgaW4gdGhlIGRvY3VtZW50IHRoYXQgbWF0Y2ggdGhlIGdpdmVuXG4gICAgICAvLyBmaWVsZC4gT25seSBvbmUgb2YgdGhlbSBuZWVkcyB0byBiZSB3aXRoaW4gJG1heERpc3RhbmNlLCBidXQgd2UgbmVlZCB0b1xuICAgICAgLy8gZXZhbHVhdGUgYWxsIG9mIHRoZW0gYW5kIHVzZSB0aGUgbmVhcmVzdCBvbmUgZm9yIHRoZSBpbXBsaWNpdCBzb3J0XG4gICAgICAvLyBzcGVjaWZpZXIuIChUaGF0J3Mgd2h5IHdlIGNhbid0IGp1c3QgdXNlIEVMRU1FTlRfT1BFUkFUT1JTIGhlcmUuKVxuICAgICAgLy9cbiAgICAgIC8vIE5vdGU6IFRoaXMgZGlmZmVycyBmcm9tIE1vbmdvREIncyBpbXBsZW1lbnRhdGlvbiwgd2hlcmUgYSBkb2N1bWVudCB3aWxsXG4gICAgICAvLyBhY3R1YWxseSBzaG93IHVwICptdWx0aXBsZSB0aW1lcyogaW4gdGhlIHJlc3VsdCBzZXQsIHdpdGggb25lIGVudHJ5IGZvclxuICAgICAgLy8gZWFjaCB3aXRoaW4tJG1heERpc3RhbmNlIGJyYW5jaGluZyBwb2ludC5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHtyZXN1bHQ6IGZhbHNlfTtcbiAgICAgIGV4cGFuZEFycmF5c0luQnJhbmNoZXMoYnJhbmNoZWRWYWx1ZXMpLmV2ZXJ5KGJyYW5jaCA9PiB7XG4gICAgICAgIC8vIGlmIG9wZXJhdGlvbiBpcyBhbiB1cGRhdGUsIGRvbid0IHNraXAgYnJhbmNoZXMsIGp1c3QgcmV0dXJuIHRoZSBmaXJzdFxuICAgICAgICAvLyBvbmUgKCMzNTk5KVxuICAgICAgICBsZXQgY3VyRGlzdGFuY2U7XG4gICAgICAgIGlmICghbWF0Y2hlci5faXNVcGRhdGUpIHtcbiAgICAgICAgICBpZiAoISh0eXBlb2YgYnJhbmNoLnZhbHVlID09PSAnb2JqZWN0JykpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGN1ckRpc3RhbmNlID0gZGlzdGFuY2UoYnJhbmNoLnZhbHVlKTtcblxuICAgICAgICAgIC8vIFNraXAgYnJhbmNoZXMgdGhhdCBhcmVuJ3QgcmVhbCBwb2ludHMgb3IgYXJlIHRvbyBmYXIgYXdheS5cbiAgICAgICAgICBpZiAoY3VyRGlzdGFuY2UgPT09IG51bGwgfHwgY3VyRGlzdGFuY2UgPiBtYXhEaXN0YW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gU2tpcCBhbnl0aGluZyB0aGF0J3MgYSB0aWUuXG4gICAgICAgICAgaWYgKHJlc3VsdC5kaXN0YW5jZSAhPT0gdW5kZWZpbmVkICYmIHJlc3VsdC5kaXN0YW5jZSA8PSBjdXJEaXN0YW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0LnJlc3VsdCA9IHRydWU7XG4gICAgICAgIHJlc3VsdC5kaXN0YW5jZSA9IGN1ckRpc3RhbmNlO1xuXG4gICAgICAgIGlmIChicmFuY2guYXJyYXlJbmRpY2VzKSB7XG4gICAgICAgICAgcmVzdWx0LmFycmF5SW5kaWNlcyA9IGJyYW5jaC5hcnJheUluZGljZXM7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgZGVsZXRlIHJlc3VsdC5hcnJheUluZGljZXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gIW1hdGNoZXIuX2lzVXBkYXRlO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcbiAgfSxcbn07XG5cbi8vIE5COiBXZSBhcmUgY2hlYXRpbmcgYW5kIHVzaW5nIHRoaXMgZnVuY3Rpb24gdG8gaW1wbGVtZW50ICdBTkQnIGZvciBib3RoXG4vLyAnZG9jdW1lbnQgbWF0Y2hlcnMnIGFuZCAnYnJhbmNoZWQgbWF0Y2hlcnMnLiBUaGV5IGJvdGggcmV0dXJuIHJlc3VsdCBvYmplY3RzXG4vLyBidXQgdGhlIGFyZ3VtZW50IGlzIGRpZmZlcmVudDogZm9yIHRoZSBmb3JtZXIgaXQncyBhIHdob2xlIGRvYywgd2hlcmVhcyBmb3Jcbi8vIHRoZSBsYXR0ZXIgaXQncyBhbiBhcnJheSBvZiAnYnJhbmNoZWQgdmFsdWVzJy5cbmZ1bmN0aW9uIGFuZFNvbWVNYXRjaGVycyhzdWJNYXRjaGVycykge1xuICBpZiAoc3ViTWF0Y2hlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGV2ZXJ5dGhpbmdNYXRjaGVyO1xuICB9XG5cbiAgaWYgKHN1Yk1hdGNoZXJzLmxlbmd0aCA9PT0gMSkge1xuICAgIHJldHVybiBzdWJNYXRjaGVyc1swXTtcbiAgfVxuXG4gIHJldHVybiBkb2NPckJyYW5jaGVzID0+IHtcbiAgICBjb25zdCBtYXRjaCA9IHt9O1xuICAgIG1hdGNoLnJlc3VsdCA9IHN1Yk1hdGNoZXJzLmV2ZXJ5KGZuID0+IHtcbiAgICAgIGNvbnN0IHN1YlJlc3VsdCA9IGZuKGRvY09yQnJhbmNoZXMpO1xuXG4gICAgICAvLyBDb3B5IGEgJ2Rpc3RhbmNlJyBudW1iZXIgb3V0IG9mIHRoZSBmaXJzdCBzdWItbWF0Y2hlciB0aGF0IGhhc1xuICAgICAgLy8gb25lLiBZZXMsIHRoaXMgbWVhbnMgdGhhdCBpZiB0aGVyZSBhcmUgbXVsdGlwbGUgJG5lYXIgZmllbGRzIGluIGFcbiAgICAgIC8vIHF1ZXJ5LCBzb21ldGhpbmcgYXJiaXRyYXJ5IGhhcHBlbnM7IHRoaXMgYXBwZWFycyB0byBiZSBjb25zaXN0ZW50IHdpdGhcbiAgICAgIC8vIE1vbmdvLlxuICAgICAgaWYgKHN1YlJlc3VsdC5yZXN1bHQgJiZcbiAgICAgICAgICBzdWJSZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAgIG1hdGNoLmRpc3RhbmNlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgbWF0Y2guZGlzdGFuY2UgPSBzdWJSZXN1bHQuZGlzdGFuY2U7XG4gICAgICB9XG5cbiAgICAgIC8vIFNpbWlsYXJseSwgcHJvcGFnYXRlIGFycmF5SW5kaWNlcyBmcm9tIHN1Yi1tYXRjaGVycy4uLiBidXQgdG8gbWF0Y2hcbiAgICAgIC8vIE1vbmdvREIgYmVoYXZpb3IsIHRoaXMgdGltZSB0aGUgKmxhc3QqIHN1Yi1tYXRjaGVyIHdpdGggYXJyYXlJbmRpY2VzXG4gICAgICAvLyB3aW5zLlxuICAgICAgaWYgKHN1YlJlc3VsdC5yZXN1bHQgJiYgc3ViUmVzdWx0LmFycmF5SW5kaWNlcykge1xuICAgICAgICBtYXRjaC5hcnJheUluZGljZXMgPSBzdWJSZXN1bHQuYXJyYXlJbmRpY2VzO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gc3ViUmVzdWx0LnJlc3VsdDtcbiAgICB9KTtcblxuICAgIC8vIElmIHdlIGRpZG4ndCBhY3R1YWxseSBtYXRjaCwgZm9yZ2V0IGFueSBleHRyYSBtZXRhZGF0YSB3ZSBjYW1lIHVwIHdpdGguXG4gICAgaWYgKCFtYXRjaC5yZXN1bHQpIHtcbiAgICAgIGRlbGV0ZSBtYXRjaC5kaXN0YW5jZTtcbiAgICAgIGRlbGV0ZSBtYXRjaC5hcnJheUluZGljZXM7XG4gICAgfVxuXG4gICAgcmV0dXJuIG1hdGNoO1xuICB9O1xufVxuXG5jb25zdCBhbmREb2N1bWVudE1hdGNoZXJzID0gYW5kU29tZU1hdGNoZXJzO1xuY29uc3QgYW5kQnJhbmNoZWRNYXRjaGVycyA9IGFuZFNvbWVNYXRjaGVycztcblxuZnVuY3Rpb24gY29tcGlsZUFycmF5T2ZEb2N1bWVudFNlbGVjdG9ycyhzZWxlY3RvcnMsIG1hdGNoZXIsIGluRWxlbU1hdGNoKSB7XG4gIGlmICghQXJyYXkuaXNBcnJheShzZWxlY3RvcnMpIHx8IHNlbGVjdG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBFcnJvcignJGFuZC8kb3IvJG5vciBtdXN0IGJlIG5vbmVtcHR5IGFycmF5Jyk7XG4gIH1cblxuICByZXR1cm4gc2VsZWN0b3JzLm1hcChzdWJTZWxlY3RvciA9PiB7XG4gICAgaWYgKCFMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3Qoc3ViU2VsZWN0b3IpKSB7XG4gICAgICB0aHJvdyBFcnJvcignJG9yLyRhbmQvJG5vciBlbnRyaWVzIG5lZWQgdG8gYmUgZnVsbCBvYmplY3RzJyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNvbXBpbGVEb2N1bWVudFNlbGVjdG9yKHN1YlNlbGVjdG9yLCBtYXRjaGVyLCB7aW5FbGVtTWF0Y2h9KTtcbiAgfSk7XG59XG5cbi8vIFRha2VzIGluIGEgc2VsZWN0b3IgdGhhdCBjb3VsZCBtYXRjaCBhIGZ1bGwgZG9jdW1lbnQgKGVnLCB0aGUgb3JpZ2luYWxcbi8vIHNlbGVjdG9yKS4gUmV0dXJucyBhIGZ1bmN0aW9uIG1hcHBpbmcgZG9jdW1lbnQtPnJlc3VsdCBvYmplY3QuXG4vL1xuLy8gbWF0Y2hlciBpcyB0aGUgTWF0Y2hlciBvYmplY3Qgd2UgYXJlIGNvbXBpbGluZy5cbi8vXG4vLyBJZiB0aGlzIGlzIHRoZSByb290IGRvY3VtZW50IHNlbGVjdG9yIChpZSwgbm90IHdyYXBwZWQgaW4gJGFuZCBvciB0aGUgbGlrZSksXG4vLyB0aGVuIGlzUm9vdCBpcyB0cnVlLiAoVGhpcyBpcyB1c2VkIGJ5ICRuZWFyLilcbmV4cG9ydCBmdW5jdGlvbiBjb21waWxlRG9jdW1lbnRTZWxlY3Rvcihkb2NTZWxlY3RvciwgbWF0Y2hlciwgb3B0aW9ucyA9IHt9KSB7XG4gIGNvbnN0IGRvY01hdGNoZXJzID0gT2JqZWN0LmtleXMoZG9jU2VsZWN0b3IpLm1hcChrZXkgPT4ge1xuICAgIGNvbnN0IHN1YlNlbGVjdG9yID0gZG9jU2VsZWN0b3Jba2V5XTtcblxuICAgIGlmIChrZXkuc3Vic3RyKDAsIDEpID09PSAnJCcpIHtcbiAgICAgIC8vIE91dGVyIG9wZXJhdG9ycyBhcmUgZWl0aGVyIGxvZ2ljYWwgb3BlcmF0b3JzICh0aGV5IHJlY3Vyc2UgYmFjayBpbnRvXG4gICAgICAvLyB0aGlzIGZ1bmN0aW9uKSwgb3IgJHdoZXJlLlxuICAgICAgaWYgKCFoYXNPd24uY2FsbChMT0dJQ0FMX09QRVJBVE9SUywga2V5KSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVucmVjb2duaXplZCBsb2dpY2FsIG9wZXJhdG9yOiAke2tleX1gKTtcbiAgICAgIH1cblxuICAgICAgbWF0Y2hlci5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICAgIHJldHVybiBMT0dJQ0FMX09QRVJBVE9SU1trZXldKHN1YlNlbGVjdG9yLCBtYXRjaGVyLCBvcHRpb25zLmluRWxlbU1hdGNoKTtcbiAgICB9XG5cbiAgICAvLyBSZWNvcmQgdGhpcyBwYXRoLCBidXQgb25seSBpZiB3ZSBhcmVuJ3QgaW4gYW4gZWxlbU1hdGNoZXIsIHNpbmNlIGluIGFuXG4gICAgLy8gZWxlbU1hdGNoIHRoaXMgaXMgYSBwYXRoIGluc2lkZSBhbiBvYmplY3QgaW4gYW4gYXJyYXksIG5vdCBpbiB0aGUgZG9jXG4gICAgLy8gcm9vdC5cbiAgICBpZiAoIW9wdGlvbnMuaW5FbGVtTWF0Y2gpIHtcbiAgICAgIG1hdGNoZXIuX3JlY29yZFBhdGhVc2VkKGtleSk7XG4gICAgfVxuXG4gICAgLy8gRG9uJ3QgYWRkIGEgbWF0Y2hlciBpZiBzdWJTZWxlY3RvciBpcyBhIGZ1bmN0aW9uIC0tIHRoaXMgaXMgdG8gbWF0Y2hcbiAgICAvLyB0aGUgYmVoYXZpb3Igb2YgTWV0ZW9yIG9uIHRoZSBzZXJ2ZXIgKGluaGVyaXRlZCBmcm9tIHRoZSBub2RlIG1vbmdvZGJcbiAgICAvLyBkcml2ZXIpLCB3aGljaCBpcyB0byBpZ25vcmUgYW55IHBhcnQgb2YgYSBzZWxlY3RvciB3aGljaCBpcyBhIGZ1bmN0aW9uLlxuICAgIGlmICh0eXBlb2Ygc3ViU2VsZWN0b3IgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgY29uc3QgbG9va1VwQnlJbmRleCA9IG1ha2VMb29rdXBGdW5jdGlvbihrZXkpO1xuICAgIGNvbnN0IHZhbHVlTWF0Y2hlciA9IGNvbXBpbGVWYWx1ZVNlbGVjdG9yKFxuICAgICAgc3ViU2VsZWN0b3IsXG4gICAgICBtYXRjaGVyLFxuICAgICAgb3B0aW9ucy5pc1Jvb3RcbiAgICApO1xuXG4gICAgcmV0dXJuIGRvYyA9PiB2YWx1ZU1hdGNoZXIobG9va1VwQnlJbmRleChkb2MpKTtcbiAgfSkuZmlsdGVyKEJvb2xlYW4pO1xuXG4gIHJldHVybiBhbmREb2N1bWVudE1hdGNoZXJzKGRvY01hdGNoZXJzKTtcbn1cblxuLy8gVGFrZXMgaW4gYSBzZWxlY3RvciB0aGF0IGNvdWxkIG1hdGNoIGEga2V5LWluZGV4ZWQgdmFsdWUgaW4gYSBkb2N1bWVudDsgZWcsXG4vLyB7JGd0OiA1LCAkbHQ6IDl9LCBvciBhIHJlZ3VsYXIgZXhwcmVzc2lvbiwgb3IgYW55IG5vbi1leHByZXNzaW9uIG9iamVjdCAodG9cbi8vIGluZGljYXRlIGVxdWFsaXR5KS4gIFJldHVybnMgYSBicmFuY2hlZCBtYXRjaGVyOiBhIGZ1bmN0aW9uIG1hcHBpbmdcbi8vIFticmFuY2hlZCB2YWx1ZV0tPnJlc3VsdCBvYmplY3QuXG5mdW5jdGlvbiBjb21waWxlVmFsdWVTZWxlY3Rvcih2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyLCBpc1Jvb3QpIHtcbiAgaWYgKHZhbHVlU2VsZWN0b3IgaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICBtYXRjaGVyLl9pc1NpbXBsZSA9IGZhbHNlO1xuICAgIHJldHVybiBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlcihcbiAgICAgIHJlZ2V4cEVsZW1lbnRNYXRjaGVyKHZhbHVlU2VsZWN0b3IpXG4gICAgKTtcbiAgfVxuXG4gIGlmIChpc09wZXJhdG9yT2JqZWN0KHZhbHVlU2VsZWN0b3IpKSB7XG4gICAgcmV0dXJuIG9wZXJhdG9yQnJhbmNoZWRNYXRjaGVyKHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIsIGlzUm9vdCk7XG4gIH1cblxuICByZXR1cm4gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgZXF1YWxpdHlFbGVtZW50TWF0Y2hlcih2YWx1ZVNlbGVjdG9yKVxuICApO1xufVxuXG4vLyBHaXZlbiBhbiBlbGVtZW50IG1hdGNoZXIgKHdoaWNoIGV2YWx1YXRlcyBhIHNpbmdsZSB2YWx1ZSksIHJldHVybnMgYSBicmFuY2hlZFxuLy8gdmFsdWUgKHdoaWNoIGV2YWx1YXRlcyB0aGUgZWxlbWVudCBtYXRjaGVyIG9uIGFsbCB0aGUgYnJhbmNoZXMgYW5kIHJldHVybnMgYVxuLy8gbW9yZSBzdHJ1Y3R1cmVkIHJldHVybiB2YWx1ZSBwb3NzaWJseSBpbmNsdWRpbmcgYXJyYXlJbmRpY2VzKS5cbmZ1bmN0aW9uIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKGVsZW1lbnRNYXRjaGVyLCBvcHRpb25zID0ge30pIHtcbiAgcmV0dXJuIGJyYW5jaGVzID0+IHtcbiAgICBjb25zdCBleHBhbmRlZCA9IG9wdGlvbnMuZG9udEV4cGFuZExlYWZBcnJheXNcbiAgICAgID8gYnJhbmNoZXNcbiAgICAgIDogZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyhicmFuY2hlcywgb3B0aW9ucy5kb250SW5jbHVkZUxlYWZBcnJheXMpO1xuXG4gICAgY29uc3QgbWF0Y2ggPSB7fTtcbiAgICBtYXRjaC5yZXN1bHQgPSBleHBhbmRlZC5zb21lKGVsZW1lbnQgPT4ge1xuICAgICAgbGV0IG1hdGNoZWQgPSBlbGVtZW50TWF0Y2hlcihlbGVtZW50LnZhbHVlKTtcblxuICAgICAgLy8gU3BlY2lhbCBjYXNlIGZvciAkZWxlbU1hdGNoOiBpdCBtZWFucyBcInRydWUsIGFuZCB1c2UgdGhpcyBhcyBhbiBhcnJheVxuICAgICAgLy8gaW5kZXggaWYgSSBkaWRuJ3QgYWxyZWFkeSBoYXZlIG9uZVwiLlxuICAgICAgaWYgKHR5cGVvZiBtYXRjaGVkID09PSAnbnVtYmVyJykge1xuICAgICAgICAvLyBYWFggVGhpcyBjb2RlIGRhdGVzIGZyb20gd2hlbiB3ZSBvbmx5IHN0b3JlZCBhIHNpbmdsZSBhcnJheSBpbmRleFxuICAgICAgICAvLyAoZm9yIHRoZSBvdXRlcm1vc3QgYXJyYXkpLiBTaG91bGQgd2UgYmUgYWxzbyBpbmNsdWRpbmcgZGVlcGVyIGFycmF5XG4gICAgICAgIC8vIGluZGljZXMgZnJvbSB0aGUgJGVsZW1NYXRjaCBtYXRjaD9cbiAgICAgICAgaWYgKCFlbGVtZW50LmFycmF5SW5kaWNlcykge1xuICAgICAgICAgIGVsZW1lbnQuYXJyYXlJbmRpY2VzID0gW21hdGNoZWRdO1xuICAgICAgICB9XG5cbiAgICAgICAgbWF0Y2hlZCA9IHRydWU7XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHNvbWUgZWxlbWVudCBtYXRjaGVkLCBhbmQgaXQncyB0YWdnZWQgd2l0aCBhcnJheSBpbmRpY2VzLCBpbmNsdWRlXG4gICAgICAvLyB0aG9zZSBpbmRpY2VzIGluIG91ciByZXN1bHQgb2JqZWN0LlxuICAgICAgaWYgKG1hdGNoZWQgJiYgZWxlbWVudC5hcnJheUluZGljZXMpIHtcbiAgICAgICAgbWF0Y2guYXJyYXlJbmRpY2VzID0gZWxlbWVudC5hcnJheUluZGljZXM7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBtYXRjaGVkO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIG1hdGNoO1xuICB9O1xufVxuXG4vLyBIZWxwZXJzIGZvciAkbmVhci5cbmZ1bmN0aW9uIGRpc3RhbmNlQ29vcmRpbmF0ZVBhaXJzKGEsIGIpIHtcbiAgY29uc3QgcG9pbnRBID0gcG9pbnRUb0FycmF5KGEpO1xuICBjb25zdCBwb2ludEIgPSBwb2ludFRvQXJyYXkoYik7XG5cbiAgcmV0dXJuIE1hdGguaHlwb3QocG9pbnRBWzBdIC0gcG9pbnRCWzBdLCBwb2ludEFbMV0gLSBwb2ludEJbMV0pO1xufVxuXG4vLyBUYWtlcyBzb21ldGhpbmcgdGhhdCBpcyBub3QgYW4gb3BlcmF0b3Igb2JqZWN0IGFuZCByZXR1cm5zIGFuIGVsZW1lbnQgbWF0Y2hlclxuLy8gZm9yIGVxdWFsaXR5IHdpdGggdGhhdCB0aGluZy5cbmV4cG9ydCBmdW5jdGlvbiBlcXVhbGl0eUVsZW1lbnRNYXRjaGVyKGVsZW1lbnRTZWxlY3Rvcikge1xuICBpZiAoaXNPcGVyYXRvck9iamVjdChlbGVtZW50U2VsZWN0b3IpKSB7XG4gICAgdGhyb3cgRXJyb3IoJ0NhblxcJ3QgY3JlYXRlIGVxdWFsaXR5VmFsdWVTZWxlY3RvciBmb3Igb3BlcmF0b3Igb2JqZWN0Jyk7XG4gIH1cblxuICAvLyBTcGVjaWFsLWNhc2U6IG51bGwgYW5kIHVuZGVmaW5lZCBhcmUgZXF1YWwgKGlmIHlvdSBnb3QgdW5kZWZpbmVkIGluIHRoZXJlXG4gIC8vIHNvbWV3aGVyZSwgb3IgaWYgeW91IGdvdCBpdCBkdWUgdG8gc29tZSBicmFuY2ggYmVpbmcgbm9uLWV4aXN0ZW50IGluIHRoZVxuICAvLyB3ZWlyZCBzcGVjaWFsIGNhc2UpLCBldmVuIHRob3VnaCB0aGV5IGFyZW4ndCB3aXRoIEVKU09OLmVxdWFscy5cbiAgLy8gdW5kZWZpbmVkIG9yIG51bGxcbiAgaWYgKGVsZW1lbnRTZWxlY3RvciA9PSBudWxsKSB7XG4gICAgcmV0dXJuIHZhbHVlID0+IHZhbHVlID09IG51bGw7XG4gIH1cblxuICByZXR1cm4gdmFsdWUgPT4gTG9jYWxDb2xsZWN0aW9uLl9mLl9lcXVhbChlbGVtZW50U2VsZWN0b3IsIHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gZXZlcnl0aGluZ01hdGNoZXIoZG9jT3JCcmFuY2hlZFZhbHVlcykge1xuICByZXR1cm4ge3Jlc3VsdDogdHJ1ZX07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBleHBhbmRBcnJheXNJbkJyYW5jaGVzKGJyYW5jaGVzLCBza2lwVGhlQXJyYXlzKSB7XG4gIGNvbnN0IGJyYW5jaGVzT3V0ID0gW107XG5cbiAgYnJhbmNoZXMuZm9yRWFjaChicmFuY2ggPT4ge1xuICAgIGNvbnN0IHRoaXNJc0FycmF5ID0gQXJyYXkuaXNBcnJheShicmFuY2gudmFsdWUpO1xuXG4gICAgLy8gV2UgaW5jbHVkZSB0aGUgYnJhbmNoIGl0c2VsZiwgKlVOTEVTUyogd2UgaXQncyBhbiBhcnJheSB0aGF0IHdlJ3JlIGdvaW5nXG4gICAgLy8gdG8gaXRlcmF0ZSBhbmQgd2UncmUgdG9sZCB0byBza2lwIGFycmF5cy4gIChUaGF0J3MgcmlnaHQsIHdlIGluY2x1ZGUgc29tZVxuICAgIC8vIGFycmF5cyBldmVuIHNraXBUaGVBcnJheXMgaXMgdHJ1ZTogdGhlc2UgYXJlIGFycmF5cyB0aGF0IHdlcmUgZm91bmQgdmlhXG4gICAgLy8gZXhwbGljaXQgbnVtZXJpY2FsIGluZGljZXMuKVxuICAgIGlmICghKHNraXBUaGVBcnJheXMgJiYgdGhpc0lzQXJyYXkgJiYgIWJyYW5jaC5kb250SXRlcmF0ZSkpIHtcbiAgICAgIGJyYW5jaGVzT3V0LnB1c2goe2FycmF5SW5kaWNlczogYnJhbmNoLmFycmF5SW5kaWNlcywgdmFsdWU6IGJyYW5jaC52YWx1ZX0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzSXNBcnJheSAmJiAhYnJhbmNoLmRvbnRJdGVyYXRlKSB7XG4gICAgICBicmFuY2gudmFsdWUuZm9yRWFjaCgodmFsdWUsIGkpID0+IHtcbiAgICAgICAgYnJhbmNoZXNPdXQucHVzaCh7XG4gICAgICAgICAgYXJyYXlJbmRpY2VzOiAoYnJhbmNoLmFycmF5SW5kaWNlcyB8fCBbXSkuY29uY2F0KGkpLFxuICAgICAgICAgIHZhbHVlXG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gYnJhbmNoZXNPdXQ7XG59XG5cbi8vIEhlbHBlcnMgZm9yICRiaXRzQWxsU2V0LyRiaXRzQW55U2V0LyRiaXRzQWxsQ2xlYXIvJGJpdHNBbnlDbGVhci5cbmZ1bmN0aW9uIGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsIHNlbGVjdG9yKSB7XG4gIC8vIG51bWVyaWMgYml0bWFza1xuICAvLyBZb3UgY2FuIHByb3ZpZGUgYSBudW1lcmljIGJpdG1hc2sgdG8gYmUgbWF0Y2hlZCBhZ2FpbnN0IHRoZSBvcGVyYW5kIGZpZWxkLlxuICAvLyBJdCBtdXN0IGJlIHJlcHJlc2VudGFibGUgYXMgYSBub24tbmVnYXRpdmUgMzItYml0IHNpZ25lZCBpbnRlZ2VyLlxuICAvLyBPdGhlcndpc2UsICRiaXRzQWxsU2V0IHdpbGwgcmV0dXJuIGFuIGVycm9yLlxuICBpZiAoTnVtYmVyLmlzSW50ZWdlcihvcGVyYW5kKSAmJiBvcGVyYW5kID49IDApIHtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkobmV3IEludDMyQXJyYXkoW29wZXJhbmRdKS5idWZmZXIpO1xuICB9XG5cbiAgLy8gYmluZGF0YSBiaXRtYXNrXG4gIC8vIFlvdSBjYW4gYWxzbyB1c2UgYW4gYXJiaXRyYXJpbHkgbGFyZ2UgQmluRGF0YSBpbnN0YW5jZSBhcyBhIGJpdG1hc2suXG4gIGlmIChFSlNPTi5pc0JpbmFyeShvcGVyYW5kKSkge1xuICAgIHJldHVybiBuZXcgVWludDhBcnJheShvcGVyYW5kLmJ1ZmZlcik7XG4gIH1cblxuICAvLyBwb3NpdGlvbiBsaXN0XG4gIC8vIElmIHF1ZXJ5aW5nIGEgbGlzdCBvZiBiaXQgcG9zaXRpb25zLCBlYWNoIDxwb3NpdGlvbj4gbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZVxuICAvLyBpbnRlZ2VyLiBCaXQgcG9zaXRpb25zIHN0YXJ0IGF0IDAgZnJvbSB0aGUgbGVhc3Qgc2lnbmlmaWNhbnQgYml0LlxuICBpZiAoQXJyYXkuaXNBcnJheShvcGVyYW5kKSAmJlxuICAgICAgb3BlcmFuZC5ldmVyeSh4ID0+IE51bWJlci5pc0ludGVnZXIoeCkgJiYgeCA+PSAwKSkge1xuICAgIGNvbnN0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcigoTWF0aC5tYXgoLi4ub3BlcmFuZCkgPj4gMykgKyAxKTtcbiAgICBjb25zdCB2aWV3ID0gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyKTtcblxuICAgIG9wZXJhbmQuZm9yRWFjaCh4ID0+IHtcbiAgICAgIHZpZXdbeCA+PiAzXSB8PSAxIDw8ICh4ICYgMHg3KTtcbiAgICB9KTtcblxuICAgIHJldHVybiB2aWV3O1xuICB9XG5cbiAgLy8gYmFkIG9wZXJhbmRcbiAgdGhyb3cgRXJyb3IoXG4gICAgYG9wZXJhbmQgdG8gJHtzZWxlY3Rvcn0gbXVzdCBiZSBhIG51bWVyaWMgYml0bWFzayAocmVwcmVzZW50YWJsZSBhcyBhIGAgK1xuICAgICdub24tbmVnYXRpdmUgMzItYml0IHNpZ25lZCBpbnRlZ2VyKSwgYSBiaW5kYXRhIGJpdG1hc2sgb3IgYW4gYXJyYXkgd2l0aCAnICtcbiAgICAnYml0IHBvc2l0aW9ucyAobm9uLW5lZ2F0aXZlIGludGVnZXJzKSdcbiAgKTtcbn1cblxuZnVuY3Rpb24gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBsZW5ndGgpIHtcbiAgLy8gVGhlIGZpZWxkIHZhbHVlIG11c3QgYmUgZWl0aGVyIG51bWVyaWNhbCBvciBhIEJpbkRhdGEgaW5zdGFuY2UuIE90aGVyd2lzZSxcbiAgLy8gJGJpdHMuLi4gd2lsbCBub3QgbWF0Y2ggdGhlIGN1cnJlbnQgZG9jdW1lbnQuXG5cbiAgLy8gbnVtZXJpY2FsXG4gIGlmIChOdW1iZXIuaXNTYWZlSW50ZWdlcih2YWx1ZSkpIHtcbiAgICAvLyAkYml0cy4uLiB3aWxsIG5vdCBtYXRjaCBudW1lcmljYWwgdmFsdWVzIHRoYXQgY2Fubm90IGJlIHJlcHJlc2VudGVkIGFzIGFcbiAgICAvLyBzaWduZWQgNjQtYml0IGludGVnZXIuIFRoaXMgY2FuIGJlIHRoZSBjYXNlIGlmIGEgdmFsdWUgaXMgZWl0aGVyIHRvb1xuICAgIC8vIGxhcmdlIG9yIHNtYWxsIHRvIGZpdCBpbiBhIHNpZ25lZCA2NC1iaXQgaW50ZWdlciwgb3IgaWYgaXQgaGFzIGFcbiAgICAvLyBmcmFjdGlvbmFsIGNvbXBvbmVudC5cbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoXG4gICAgICBNYXRoLm1heChsZW5ndGgsIDIgKiBVaW50MzJBcnJheS5CWVRFU19QRVJfRUxFTUVOVClcbiAgICApO1xuXG4gICAgbGV0IHZpZXcgPSBuZXcgVWludDMyQXJyYXkoYnVmZmVyLCAwLCAyKTtcbiAgICB2aWV3WzBdID0gdmFsdWUgJSAoKDEgPDwgMTYpICogKDEgPDwgMTYpKSB8IDA7XG4gICAgdmlld1sxXSA9IHZhbHVlIC8gKCgxIDw8IDE2KSAqICgxIDw8IDE2KSkgfCAwO1xuXG4gICAgLy8gc2lnbiBleHRlbnNpb25cbiAgICBpZiAodmFsdWUgPCAwKSB7XG4gICAgICB2aWV3ID0gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyLCAyKTtcbiAgICAgIHZpZXcuZm9yRWFjaCgoYnl0ZSwgaSkgPT4ge1xuICAgICAgICB2aWV3W2ldID0gMHhmZjtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBuZXcgVWludDhBcnJheShidWZmZXIpO1xuICB9XG5cbiAgLy8gYmluZGF0YVxuICBpZiAoRUpTT04uaXNCaW5hcnkodmFsdWUpKSB7XG4gICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KHZhbHVlLmJ1ZmZlcik7XG4gIH1cblxuICAvLyBubyBtYXRjaFxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8vIEFjdHVhbGx5IGluc2VydHMgYSBrZXkgdmFsdWUgaW50byB0aGUgc2VsZWN0b3IgZG9jdW1lbnRcbi8vIEhvd2V2ZXIsIHRoaXMgY2hlY2tzIHRoZXJlIGlzIG5vIGFtYmlndWl0eSBpbiBzZXR0aW5nXG4vLyB0aGUgdmFsdWUgZm9yIHRoZSBnaXZlbiBrZXksIHRocm93cyBvdGhlcndpc2VcbmZ1bmN0aW9uIGluc2VydEludG9Eb2N1bWVudChkb2N1bWVudCwga2V5LCB2YWx1ZSkge1xuICBPYmplY3Qua2V5cyhkb2N1bWVudCkuZm9yRWFjaChleGlzdGluZ0tleSA9PiB7XG4gICAgaWYgKFxuICAgICAgKGV4aXN0aW5nS2V5Lmxlbmd0aCA+IGtleS5sZW5ndGggJiYgZXhpc3RpbmdLZXkuaW5kZXhPZihgJHtrZXl9LmApID09PSAwKSB8fFxuICAgICAgKGtleS5sZW5ndGggPiBleGlzdGluZ0tleS5sZW5ndGggJiYga2V5LmluZGV4T2YoYCR7ZXhpc3RpbmdLZXl9LmApID09PSAwKVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgY2Fubm90IGluZmVyIHF1ZXJ5IGZpZWxkcyB0byBzZXQsIGJvdGggcGF0aHMgJyR7ZXhpc3RpbmdLZXl9JyBhbmQgYCArXG4gICAgICAgIGAnJHtrZXl9JyBhcmUgbWF0Y2hlZGBcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChleGlzdGluZ0tleSA9PT0ga2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBjYW5ub3QgaW5mZXIgcXVlcnkgZmllbGRzIHRvIHNldCwgcGF0aCAnJHtrZXl9JyBpcyBtYXRjaGVkIHR3aWNlYFxuICAgICAgKTtcbiAgICB9XG4gIH0pO1xuXG4gIGRvY3VtZW50W2tleV0gPSB2YWx1ZTtcbn1cblxuLy8gUmV0dXJucyBhIGJyYW5jaGVkIG1hdGNoZXIgdGhhdCBtYXRjaGVzIGlmZiB0aGUgZ2l2ZW4gbWF0Y2hlciBkb2VzIG5vdC5cbi8vIE5vdGUgdGhhdCB0aGlzIGltcGxpY2l0bHkgXCJkZU1vcmdhbml6ZXNcIiB0aGUgd3JhcHBlZCBmdW5jdGlvbi4gIGllLCBpdFxuLy8gbWVhbnMgdGhhdCBBTEwgYnJhbmNoIHZhbHVlcyBuZWVkIHRvIGZhaWwgdG8gbWF0Y2ggaW5uZXJCcmFuY2hlZE1hdGNoZXIuXG5mdW5jdGlvbiBpbnZlcnRCcmFuY2hlZE1hdGNoZXIoYnJhbmNoZWRNYXRjaGVyKSB7XG4gIHJldHVybiBicmFuY2hWYWx1ZXMgPT4ge1xuICAgIC8vIFdlIGV4cGxpY2l0bHkgY2hvb3NlIHRvIHN0cmlwIGFycmF5SW5kaWNlcyBoZXJlOiBpdCBkb2Vzbid0IG1ha2Ugc2Vuc2UgdG9cbiAgICAvLyBzYXkgXCJ1cGRhdGUgdGhlIGFycmF5IGVsZW1lbnQgdGhhdCBkb2VzIG5vdCBtYXRjaCBzb21ldGhpbmdcIiwgYXQgbGVhc3RcbiAgICAvLyBpbiBtb25nby1sYW5kLlxuICAgIHJldHVybiB7cmVzdWx0OiAhYnJhbmNoZWRNYXRjaGVyKGJyYW5jaFZhbHVlcykucmVzdWx0fTtcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzSW5kZXhhYmxlKG9iaikge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShvYmopIHx8IExvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChvYmopO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNOdW1lcmljS2V5KHMpIHtcbiAgcmV0dXJuIC9eWzAtOV0rJC8udGVzdChzKTtcbn1cblxuLy8gUmV0dXJucyB0cnVlIGlmIHRoaXMgaXMgYW4gb2JqZWN0IHdpdGggYXQgbGVhc3Qgb25lIGtleSBhbmQgYWxsIGtleXMgYmVnaW5cbi8vIHdpdGggJC4gIFVubGVzcyBpbmNvbnNpc3RlbnRPSyBpcyBzZXQsIHRocm93cyBpZiBzb21lIGtleXMgYmVnaW4gd2l0aCAkIGFuZFxuLy8gb3RoZXJzIGRvbid0LlxuZXhwb3J0IGZ1bmN0aW9uIGlzT3BlcmF0b3JPYmplY3QodmFsdWVTZWxlY3RvciwgaW5jb25zaXN0ZW50T0spIHtcbiAgaWYgKCFMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QodmFsdWVTZWxlY3RvcikpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBsZXQgdGhlc2VBcmVPcGVyYXRvcnMgPSB1bmRlZmluZWQ7XG4gIE9iamVjdC5rZXlzKHZhbHVlU2VsZWN0b3IpLmZvckVhY2goc2VsS2V5ID0+IHtcbiAgICBjb25zdCB0aGlzSXNPcGVyYXRvciA9IHNlbEtleS5zdWJzdHIoMCwgMSkgPT09ICckJztcblxuICAgIGlmICh0aGVzZUFyZU9wZXJhdG9ycyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aGVzZUFyZU9wZXJhdG9ycyA9IHRoaXNJc09wZXJhdG9yO1xuICAgIH0gZWxzZSBpZiAodGhlc2VBcmVPcGVyYXRvcnMgIT09IHRoaXNJc09wZXJhdG9yKSB7XG4gICAgICBpZiAoIWluY29uc2lzdGVudE9LKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgSW5jb25zaXN0ZW50IG9wZXJhdG9yOiAke0pTT04uc3RyaW5naWZ5KHZhbHVlU2VsZWN0b3IpfWBcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgdGhlc2VBcmVPcGVyYXRvcnMgPSBmYWxzZTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiAhIXRoZXNlQXJlT3BlcmF0b3JzOyAvLyB7fSBoYXMgbm8gb3BlcmF0b3JzXG59XG5cbi8vIEhlbHBlciBmb3IgJGx0LyRndC8kbHRlLyRndGUuXG5mdW5jdGlvbiBtYWtlSW5lcXVhbGl0eShjbXBWYWx1ZUNvbXBhcmF0b3IpIHtcbiAgcmV0dXJuIHtcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIC8vIEFycmF5cyBuZXZlciBjb21wYXJlIGZhbHNlIHdpdGggbm9uLWFycmF5cyBmb3IgYW55IGluZXF1YWxpdHkuXG4gICAgICAvLyBYWFggVGhpcyB3YXMgYmVoYXZpb3Igd2Ugb2JzZXJ2ZWQgaW4gcHJlLXJlbGVhc2UgTW9uZ29EQiAyLjUsIGJ1dFxuICAgICAgLy8gICAgIGl0IHNlZW1zIHRvIGhhdmUgYmVlbiByZXZlcnRlZC5cbiAgICAgIC8vICAgICBTZWUgaHR0cHM6Ly9qaXJhLm1vbmdvZGIub3JnL2Jyb3dzZS9TRVJWRVItMTE0NDRcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KG9wZXJhbmQpKSB7XG4gICAgICAgIHJldHVybiAoKSA9PiBmYWxzZTtcbiAgICAgIH1cblxuICAgICAgLy8gU3BlY2lhbCBjYXNlOiBjb25zaWRlciB1bmRlZmluZWQgYW5kIG51bGwgdGhlIHNhbWUgKHNvIHRydWUgd2l0aFxuICAgICAgLy8gJGd0ZS8kbHRlKS5cbiAgICAgIGlmIChvcGVyYW5kID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgb3BlcmFuZCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG9wZXJhbmRUeXBlID0gTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKG9wZXJhbmQpO1xuXG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHZhbHVlID0gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENvbXBhcmlzb25zIGFyZSBuZXZlciB0cnVlIGFtb25nIHRoaW5ncyBvZiBkaWZmZXJlbnQgdHlwZSAoZXhjZXB0XG4gICAgICAgIC8vIG51bGwgdnMgdW5kZWZpbmVkKS5cbiAgICAgICAgaWYgKExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZSh2YWx1ZSkgIT09IG9wZXJhbmRUeXBlKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNtcFZhbHVlQ29tcGFyYXRvcihMb2NhbENvbGxlY3Rpb24uX2YuX2NtcCh2YWx1ZSwgb3BlcmFuZCkpO1xuICAgICAgfTtcbiAgICB9LFxuICB9O1xufVxuXG4vLyBtYWtlTG9va3VwRnVuY3Rpb24oa2V5KSByZXR1cm5zIGEgbG9va3VwIGZ1bmN0aW9uLlxuLy9cbi8vIEEgbG9va3VwIGZ1bmN0aW9uIHRha2VzIGluIGEgZG9jdW1lbnQgYW5kIHJldHVybnMgYW4gYXJyYXkgb2YgbWF0Y2hpbmdcbi8vIGJyYW5jaGVzLiAgSWYgbm8gYXJyYXlzIGFyZSBmb3VuZCB3aGlsZSBsb29raW5nIHVwIHRoZSBrZXksIHRoaXMgYXJyYXkgd2lsbFxuLy8gaGF2ZSBleGFjdGx5IG9uZSBicmFuY2hlcyAocG9zc2libHkgJ3VuZGVmaW5lZCcsIGlmIHNvbWUgc2VnbWVudCBvZiB0aGUga2V5XG4vLyB3YXMgbm90IGZvdW5kKS5cbi8vXG4vLyBJZiBhcnJheXMgYXJlIGZvdW5kIGluIHRoZSBtaWRkbGUsIHRoaXMgY2FuIGhhdmUgbW9yZSB0aGFuIG9uZSBlbGVtZW50LCBzaW5jZVxuLy8gd2UgJ2JyYW5jaCcuIFdoZW4gd2UgJ2JyYW5jaCcsIGlmIHRoZXJlIGFyZSBtb3JlIGtleSBzZWdtZW50cyB0byBsb29rIHVwLFxuLy8gdGhlbiB3ZSBvbmx5IHB1cnN1ZSBicmFuY2hlcyB0aGF0IGFyZSBwbGFpbiBvYmplY3RzIChub3QgYXJyYXlzIG9yIHNjYWxhcnMpLlxuLy8gVGhpcyBtZWFucyB3ZSBjYW4gYWN0dWFsbHkgZW5kIHVwIHdpdGggbm8gYnJhbmNoZXMhXG4vL1xuLy8gV2UgZG8gKk5PVCogYnJhbmNoIG9uIGFycmF5cyB0aGF0IGFyZSBmb3VuZCBhdCB0aGUgZW5kIChpZSwgYXQgdGhlIGxhc3Rcbi8vIGRvdHRlZCBtZW1iZXIgb2YgdGhlIGtleSkuIFdlIGp1c3QgcmV0dXJuIHRoYXQgYXJyYXk7IGlmIHlvdSB3YW50IHRvXG4vLyBlZmZlY3RpdmVseSAnYnJhbmNoJyBvdmVyIHRoZSBhcnJheSdzIHZhbHVlcywgcG9zdC1wcm9jZXNzIHRoZSBsb29rdXBcbi8vIGZ1bmN0aW9uIHdpdGggZXhwYW5kQXJyYXlzSW5CcmFuY2hlcy5cbi8vXG4vLyBFYWNoIGJyYW5jaCBpcyBhbiBvYmplY3Qgd2l0aCBrZXlzOlxuLy8gIC0gdmFsdWU6IHRoZSB2YWx1ZSBhdCB0aGUgYnJhbmNoXG4vLyAgLSBkb250SXRlcmF0ZTogYW4gb3B0aW9uYWwgYm9vbDsgaWYgdHJ1ZSwgaXQgbWVhbnMgdGhhdCAndmFsdWUnIGlzIGFuIGFycmF5XG4vLyAgICB0aGF0IGV4cGFuZEFycmF5c0luQnJhbmNoZXMgc2hvdWxkIE5PVCBleHBhbmQuIFRoaXMgc3BlY2lmaWNhbGx5IGhhcHBlbnNcbi8vICAgIHdoZW4gdGhlcmUgaXMgYSBudW1lcmljIGluZGV4IGluIHRoZSBrZXksIGFuZCBlbnN1cmVzIHRoZVxuLy8gICAgcGVyaGFwcy1zdXJwcmlzaW5nIE1vbmdvREIgYmVoYXZpb3Igd2hlcmUgeydhLjAnOiA1fSBkb2VzIE5PVFxuLy8gICAgbWF0Y2gge2E6IFtbNV1dfS5cbi8vICAtIGFycmF5SW5kaWNlczogaWYgYW55IGFycmF5IGluZGV4aW5nIHdhcyBkb25lIGR1cmluZyBsb29rdXAgKGVpdGhlciBkdWUgdG9cbi8vICAgIGV4cGxpY2l0IG51bWVyaWMgaW5kaWNlcyBvciBpbXBsaWNpdCBicmFuY2hpbmcpLCB0aGlzIHdpbGwgYmUgYW4gYXJyYXkgb2Zcbi8vICAgIHRoZSBhcnJheSBpbmRpY2VzIHVzZWQsIGZyb20gb3V0ZXJtb3N0IHRvIGlubmVybW9zdDsgaXQgaXMgZmFsc2V5IG9yXG4vLyAgICBhYnNlbnQgaWYgbm8gYXJyYXkgaW5kZXggaXMgdXNlZC4gSWYgYW4gZXhwbGljaXQgbnVtZXJpYyBpbmRleCBpcyB1c2VkLFxuLy8gICAgdGhlIGluZGV4IHdpbGwgYmUgZm9sbG93ZWQgaW4gYXJyYXlJbmRpY2VzIGJ5IHRoZSBzdHJpbmcgJ3gnLlxuLy9cbi8vICAgIE5vdGU6IGFycmF5SW5kaWNlcyBpcyB1c2VkIGZvciB0d28gcHVycG9zZXMuIEZpcnN0LCBpdCBpcyB1c2VkIHRvXG4vLyAgICBpbXBsZW1lbnQgdGhlICckJyBtb2RpZmllciBmZWF0dXJlLCB3aGljaCBvbmx5IGV2ZXIgbG9va3MgYXQgaXRzIGZpcnN0XG4vLyAgICBlbGVtZW50LlxuLy9cbi8vICAgIFNlY29uZCwgaXQgaXMgdXNlZCBmb3Igc29ydCBrZXkgZ2VuZXJhdGlvbiwgd2hpY2ggbmVlZHMgdG8gYmUgYWJsZSB0byB0ZWxsXG4vLyAgICB0aGUgZGlmZmVyZW5jZSBiZXR3ZWVuIGRpZmZlcmVudCBwYXRocy4gTW9yZW92ZXIsIGl0IG5lZWRzIHRvXG4vLyAgICBkaWZmZXJlbnRpYXRlIGJldHdlZW4gZXhwbGljaXQgYW5kIGltcGxpY2l0IGJyYW5jaGluZywgd2hpY2ggaXMgd2h5XG4vLyAgICB0aGVyZSdzIHRoZSBzb21ld2hhdCBoYWNreSAneCcgZW50cnk6IHRoaXMgbWVhbnMgdGhhdCBleHBsaWNpdCBhbmRcbi8vICAgIGltcGxpY2l0IGFycmF5IGxvb2t1cHMgd2lsbCBoYXZlIGRpZmZlcmVudCBmdWxsIGFycmF5SW5kaWNlcyBwYXRocy4gKFRoYXRcbi8vICAgIGNvZGUgb25seSByZXF1aXJlcyB0aGF0IGRpZmZlcmVudCBwYXRocyBoYXZlIGRpZmZlcmVudCBhcnJheUluZGljZXM7IGl0XG4vLyAgICBkb2Vzbid0IGFjdHVhbGx5ICdwYXJzZScgYXJyYXlJbmRpY2VzLiBBcyBhbiBhbHRlcm5hdGl2ZSwgYXJyYXlJbmRpY2VzXG4vLyAgICBjb3VsZCBjb250YWluIG9iamVjdHMgd2l0aCBmbGFncyBsaWtlICdpbXBsaWNpdCcsIGJ1dCBJIHRoaW5rIHRoYXQgb25seVxuLy8gICAgbWFrZXMgdGhlIGNvZGUgc3Vycm91bmRpbmcgdGhlbSBtb3JlIGNvbXBsZXguKVxuLy9cbi8vICAgIChCeSB0aGUgd2F5LCB0aGlzIGZpZWxkIGVuZHMgdXAgZ2V0dGluZyBwYXNzZWQgYXJvdW5kIGEgbG90IHdpdGhvdXRcbi8vICAgIGNsb25pbmcsIHNvIG5ldmVyIG11dGF0ZSBhbnkgYXJyYXlJbmRpY2VzIGZpZWxkL3ZhciBpbiB0aGlzIHBhY2thZ2UhKVxuLy9cbi8vXG4vLyBBdCB0aGUgdG9wIGxldmVsLCB5b3UgbWF5IG9ubHkgcGFzcyBpbiBhIHBsYWluIG9iamVjdCBvciBhcnJheS5cbi8vXG4vLyBTZWUgdGhlIHRlc3QgJ21pbmltb25nbyAtIGxvb2t1cCcgZm9yIHNvbWUgZXhhbXBsZXMgb2Ygd2hhdCBsb29rdXAgZnVuY3Rpb25zXG4vLyByZXR1cm4uXG5leHBvcnQgZnVuY3Rpb24gbWFrZUxvb2t1cEZ1bmN0aW9uKGtleSwgb3B0aW9ucyA9IHt9KSB7XG4gIGNvbnN0IHBhcnRzID0ga2V5LnNwbGl0KCcuJyk7XG4gIGNvbnN0IGZpcnN0UGFydCA9IHBhcnRzLmxlbmd0aCA/IHBhcnRzWzBdIDogJyc7XG4gIGNvbnN0IGxvb2t1cFJlc3QgPSAoXG4gICAgcGFydHMubGVuZ3RoID4gMSAmJlxuICAgIG1ha2VMb29rdXBGdW5jdGlvbihwYXJ0cy5zbGljZSgxKS5qb2luKCcuJyksIG9wdGlvbnMpXG4gICk7XG5cbiAgY29uc3Qgb21pdFVubmVjZXNzYXJ5RmllbGRzID0gcmVzdWx0ID0+IHtcbiAgICBpZiAoIXJlc3VsdC5kb250SXRlcmF0ZSkge1xuICAgICAgZGVsZXRlIHJlc3VsdC5kb250SXRlcmF0ZTtcbiAgICB9XG5cbiAgICBpZiAocmVzdWx0LmFycmF5SW5kaWNlcyAmJiAhcmVzdWx0LmFycmF5SW5kaWNlcy5sZW5ndGgpIHtcbiAgICAgIGRlbGV0ZSByZXN1bHQuYXJyYXlJbmRpY2VzO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG5cbiAgLy8gRG9jIHdpbGwgYWx3YXlzIGJlIGEgcGxhaW4gb2JqZWN0IG9yIGFuIGFycmF5LlxuICAvLyBhcHBseSBhbiBleHBsaWNpdCBudW1lcmljIGluZGV4LCBhbiBhcnJheS5cbiAgcmV0dXJuIChkb2MsIGFycmF5SW5kaWNlcyA9IFtdKSA9PiB7XG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZG9jKSkge1xuICAgICAgLy8gSWYgd2UncmUgYmVpbmcgYXNrZWQgdG8gZG8gYW4gaW52YWxpZCBsb29rdXAgaW50byBhbiBhcnJheSAobm9uLWludGVnZXJcbiAgICAgIC8vIG9yIG91dC1vZi1ib3VuZHMpLCByZXR1cm4gbm8gcmVzdWx0cyAod2hpY2ggaXMgZGlmZmVyZW50IGZyb20gcmV0dXJuaW5nXG4gICAgICAvLyBhIHNpbmdsZSB1bmRlZmluZWQgcmVzdWx0LCBpbiB0aGF0IGBudWxsYCBlcXVhbGl0eSBjaGVja3Mgd29uJ3QgbWF0Y2gpLlxuICAgICAgaWYgKCEoaXNOdW1lcmljS2V5KGZpcnN0UGFydCkgJiYgZmlyc3RQYXJ0IDwgZG9jLmxlbmd0aCkpIHtcbiAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgfVxuXG4gICAgICAvLyBSZW1lbWJlciB0aGF0IHdlIHVzZWQgdGhpcyBhcnJheSBpbmRleC4gSW5jbHVkZSBhbiAneCcgdG8gaW5kaWNhdGUgdGhhdFxuICAgICAgLy8gdGhlIHByZXZpb3VzIGluZGV4IGNhbWUgZnJvbSBiZWluZyBjb25zaWRlcmVkIGFzIGFuIGV4cGxpY2l0IGFycmF5XG4gICAgICAvLyBpbmRleCAobm90IGJyYW5jaGluZykuXG4gICAgICBhcnJheUluZGljZXMgPSBhcnJheUluZGljZXMuY29uY2F0KCtmaXJzdFBhcnQsICd4Jyk7XG4gICAgfVxuXG4gICAgLy8gRG8gb3VyIGZpcnN0IGxvb2t1cC5cbiAgICBjb25zdCBmaXJzdExldmVsID0gZG9jW2ZpcnN0UGFydF07XG5cbiAgICAvLyBJZiB0aGVyZSBpcyBubyBkZWVwZXIgdG8gZGlnLCByZXR1cm4gd2hhdCB3ZSBmb3VuZC5cbiAgICAvL1xuICAgIC8vIElmIHdoYXQgd2UgZm91bmQgaXMgYW4gYXJyYXksIG1vc3QgdmFsdWUgc2VsZWN0b3JzIHdpbGwgY2hvb3NlIHRvIHRyZWF0XG4gICAgLy8gdGhlIGVsZW1lbnRzIG9mIHRoZSBhcnJheSBhcyBtYXRjaGFibGUgdmFsdWVzIGluIHRoZWlyIG93biByaWdodCwgYnV0XG4gICAgLy8gdGhhdCdzIGRvbmUgb3V0c2lkZSBvZiB0aGUgbG9va3VwIGZ1bmN0aW9uLiAoRXhjZXB0aW9ucyB0byB0aGlzIGFyZSAkc2l6ZVxuICAgIC8vIGFuZCBzdHVmZiByZWxhdGluZyB0byAkZWxlbU1hdGNoLiAgZWcsIHthOiB7JHNpemU6IDJ9fSBkb2VzIG5vdCBtYXRjaCB7YTpcbiAgICAvLyBbWzEsIDJdXX0uKVxuICAgIC8vXG4gICAgLy8gVGhhdCBzYWlkLCBpZiB3ZSBqdXN0IGRpZCBhbiAqZXhwbGljaXQqIGFycmF5IGxvb2t1cCAob24gZG9jKSB0byBmaW5kXG4gICAgLy8gZmlyc3RMZXZlbCwgYW5kIGZpcnN0TGV2ZWwgaXMgYW4gYXJyYXkgdG9vLCB3ZSBkbyBOT1Qgd2FudCB2YWx1ZVxuICAgIC8vIHNlbGVjdG9ycyB0byBpdGVyYXRlIG92ZXIgaXQuICBlZywgeydhLjAnOiA1fSBkb2VzIG5vdCBtYXRjaCB7YTogW1s1XV19LlxuICAgIC8vIFNvIGluIHRoYXQgY2FzZSwgd2UgbWFyayB0aGUgcmV0dXJuIHZhbHVlIGFzICdkb24ndCBpdGVyYXRlJy5cbiAgICBpZiAoIWxvb2t1cFJlc3QpIHtcbiAgICAgIHJldHVybiBbb21pdFVubmVjZXNzYXJ5RmllbGRzKHtcbiAgICAgICAgYXJyYXlJbmRpY2VzLFxuICAgICAgICBkb250SXRlcmF0ZTogQXJyYXkuaXNBcnJheShkb2MpICYmIEFycmF5LmlzQXJyYXkoZmlyc3RMZXZlbCksXG4gICAgICAgIHZhbHVlOiBmaXJzdExldmVsXG4gICAgICB9KV07XG4gICAgfVxuXG4gICAgLy8gV2UgbmVlZCB0byBkaWcgZGVlcGVyLiAgQnV0IGlmIHdlIGNhbid0LCBiZWNhdXNlIHdoYXQgd2UndmUgZm91bmQgaXMgbm90XG4gICAgLy8gYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0LCB3ZSdyZSBkb25lLiBJZiB3ZSBqdXN0IGRpZCBhIG51bWVyaWMgaW5kZXggaW50b1xuICAgIC8vIGFuIGFycmF5LCB3ZSByZXR1cm4gbm90aGluZyBoZXJlICh0aGlzIGlzIGEgY2hhbmdlIGluIE1vbmdvIDIuNSBmcm9tXG4gICAgLy8gTW9uZ28gMi40LCB3aGVyZSB7J2EuMC5iJzogbnVsbH0gc3RvcHBlZCBtYXRjaGluZyB7YTogWzVdfSkuIE90aGVyd2lzZSxcbiAgICAvLyByZXR1cm4gYSBzaW5nbGUgYHVuZGVmaW5lZGAgKHdoaWNoIGNhbiwgZm9yIGV4YW1wbGUsIG1hdGNoIHZpYSBlcXVhbGl0eVxuICAgIC8vIHdpdGggYG51bGxgKS5cbiAgICBpZiAoIWlzSW5kZXhhYmxlKGZpcnN0TGV2ZWwpKSB7XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShkb2MpKSB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIFtvbWl0VW5uZWNlc3NhcnlGaWVsZHMoe2FycmF5SW5kaWNlcywgdmFsdWU6IHVuZGVmaW5lZH0pXTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBbXTtcbiAgICBjb25zdCBhcHBlbmRUb1Jlc3VsdCA9IG1vcmUgPT4ge1xuICAgICAgcmVzdWx0LnB1c2goLi4ubW9yZSk7XG4gICAgfTtcblxuICAgIC8vIERpZyBkZWVwZXI6IGxvb2sgdXAgdGhlIHJlc3Qgb2YgdGhlIHBhcnRzIG9uIHdoYXRldmVyIHdlJ3ZlIGZvdW5kLlxuICAgIC8vIChsb29rdXBSZXN0IGlzIHNtYXJ0IGVub3VnaCB0byBub3QgdHJ5IHRvIGRvIGludmFsaWQgbG9va3VwcyBpbnRvXG4gICAgLy8gZmlyc3RMZXZlbCBpZiBpdCdzIGFuIGFycmF5LilcbiAgICBhcHBlbmRUb1Jlc3VsdChsb29rdXBSZXN0KGZpcnN0TGV2ZWwsIGFycmF5SW5kaWNlcykpO1xuXG4gICAgLy8gSWYgd2UgZm91bmQgYW4gYXJyYXksIHRoZW4gaW4gKmFkZGl0aW9uKiB0byBwb3RlbnRpYWxseSB0cmVhdGluZyB0aGUgbmV4dFxuICAgIC8vIHBhcnQgYXMgYSBsaXRlcmFsIGludGVnZXIgbG9va3VwLCB3ZSBzaG91bGQgYWxzbyAnYnJhbmNoJzogdHJ5IHRvIGxvb2sgdXBcbiAgICAvLyB0aGUgcmVzdCBvZiB0aGUgcGFydHMgb24gZWFjaCBhcnJheSBlbGVtZW50IGluIHBhcmFsbGVsLlxuICAgIC8vXG4gICAgLy8gSW4gdGhpcyBjYXNlLCB3ZSAqb25seSogZGlnIGRlZXBlciBpbnRvIGFycmF5IGVsZW1lbnRzIHRoYXQgYXJlIHBsYWluXG4gICAgLy8gb2JqZWN0cy4gKFJlY2FsbCB0aGF0IHdlIG9ubHkgZ290IHRoaXMgZmFyIGlmIHdlIGhhdmUgZnVydGhlciB0byBkaWcuKVxuICAgIC8vIFRoaXMgbWFrZXMgc2Vuc2U6IHdlIGNlcnRhaW5seSBkb24ndCBkaWcgZGVlcGVyIGludG8gbm9uLWluZGV4YWJsZVxuICAgIC8vIG9iamVjdHMuIEFuZCBpdCB3b3VsZCBiZSB3ZWlyZCB0byBkaWcgaW50byBhbiBhcnJheTogaXQncyBzaW1wbGVyIHRvIGhhdmVcbiAgICAvLyBhIHJ1bGUgdGhhdCBleHBsaWNpdCBpbnRlZ2VyIGluZGV4ZXMgb25seSBhcHBseSB0byBhbiBvdXRlciBhcnJheSwgbm90IHRvXG4gICAgLy8gYW4gYXJyYXkgeW91IGZpbmQgYWZ0ZXIgYSBicmFuY2hpbmcgc2VhcmNoLlxuICAgIC8vXG4gICAgLy8gSW4gdGhlIHNwZWNpYWwgY2FzZSBvZiBhIG51bWVyaWMgcGFydCBpbiBhICpzb3J0IHNlbGVjdG9yKiAobm90IGEgcXVlcnlcbiAgICAvLyBzZWxlY3RvciksIHdlIHNraXAgdGhlIGJyYW5jaGluZzogd2UgT05MWSBhbGxvdyB0aGUgbnVtZXJpYyBwYXJ0IHRvIG1lYW5cbiAgICAvLyAnbG9vayB1cCB0aGlzIGluZGV4JyBpbiB0aGF0IGNhc2UsIG5vdCAnYWxzbyBsb29rIHVwIHRoaXMgaW5kZXggaW4gYWxsXG4gICAgLy8gdGhlIGVsZW1lbnRzIG9mIHRoZSBhcnJheScuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZmlyc3RMZXZlbCkgJiZcbiAgICAgICAgIShpc051bWVyaWNLZXkocGFydHNbMV0pICYmIG9wdGlvbnMuZm9yU29ydCkpIHtcbiAgICAgIGZpcnN0TGV2ZWwuZm9yRWFjaCgoYnJhbmNoLCBhcnJheUluZGV4KSA9PiB7XG4gICAgICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QoYnJhbmNoKSkge1xuICAgICAgICAgIGFwcGVuZFRvUmVzdWx0KGxvb2t1cFJlc3QoYnJhbmNoLCBhcnJheUluZGljZXMuY29uY2F0KGFycmF5SW5kZXgpKSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG59XG5cbi8vIE9iamVjdCBleHBvcnRlZCBvbmx5IGZvciB1bml0IHRlc3RpbmcuXG4vLyBVc2UgaXQgdG8gZXhwb3J0IHByaXZhdGUgZnVuY3Rpb25zIHRvIHRlc3QgaW4gVGlueXRlc3QuXG5NaW5pbW9uZ29UZXN0ID0ge21ha2VMb29rdXBGdW5jdGlvbn07XG5NaW5pbW9uZ29FcnJvciA9IChtZXNzYWdlLCBvcHRpb25zID0ge30pID0+IHtcbiAgaWYgKHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJyAmJiBvcHRpb25zLmZpZWxkKSB7XG4gICAgbWVzc2FnZSArPSBgIGZvciBmaWVsZCAnJHtvcHRpb25zLmZpZWxkfSdgO1xuICB9XG5cbiAgY29uc3QgZXJyb3IgPSBuZXcgRXJyb3IobWVzc2FnZSk7XG4gIGVycm9yLm5hbWUgPSAnTWluaW1vbmdvRXJyb3InO1xuICByZXR1cm4gZXJyb3I7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gbm90aGluZ01hdGNoZXIoZG9jT3JCcmFuY2hlZFZhbHVlcykge1xuICByZXR1cm4ge3Jlc3VsdDogZmFsc2V9O1xufVxuXG4vLyBUYWtlcyBhbiBvcGVyYXRvciBvYmplY3QgKGFuIG9iamVjdCB3aXRoICQga2V5cykgYW5kIHJldHVybnMgYSBicmFuY2hlZFxuLy8gbWF0Y2hlciBmb3IgaXQuXG5mdW5jdGlvbiBvcGVyYXRvckJyYW5jaGVkTWF0Y2hlcih2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyLCBpc1Jvb3QpIHtcbiAgLy8gRWFjaCB2YWx1ZVNlbGVjdG9yIHdvcmtzIHNlcGFyYXRlbHkgb24gdGhlIHZhcmlvdXMgYnJhbmNoZXMuICBTbyBvbmVcbiAgLy8gb3BlcmF0b3IgY2FuIG1hdGNoIG9uZSBicmFuY2ggYW5kIGFub3RoZXIgY2FuIG1hdGNoIGFub3RoZXIgYnJhbmNoLiAgVGhpc1xuICAvLyBpcyBPSy5cbiAgY29uc3Qgb3BlcmF0b3JNYXRjaGVycyA9IE9iamVjdC5rZXlzKHZhbHVlU2VsZWN0b3IpLm1hcChvcGVyYXRvciA9PiB7XG4gICAgY29uc3Qgb3BlcmFuZCA9IHZhbHVlU2VsZWN0b3Jbb3BlcmF0b3JdO1xuXG4gICAgY29uc3Qgc2ltcGxlUmFuZ2UgPSAoXG4gICAgICBbJyRsdCcsICckbHRlJywgJyRndCcsICckZ3RlJ10uaW5jbHVkZXMob3BlcmF0b3IpICYmXG4gICAgICB0eXBlb2Ygb3BlcmFuZCA9PT0gJ251bWJlcidcbiAgICApO1xuXG4gICAgY29uc3Qgc2ltcGxlRXF1YWxpdHkgPSAoXG4gICAgICBbJyRuZScsICckZXEnXS5pbmNsdWRlcyhvcGVyYXRvcikgJiZcbiAgICAgIG9wZXJhbmQgIT09IE9iamVjdChvcGVyYW5kKVxuICAgICk7XG5cbiAgICBjb25zdCBzaW1wbGVJbmNsdXNpb24gPSAoXG4gICAgICBbJyRpbicsICckbmluJ10uaW5jbHVkZXMob3BlcmF0b3IpXG4gICAgICAmJiBBcnJheS5pc0FycmF5KG9wZXJhbmQpXG4gICAgICAmJiAhb3BlcmFuZC5zb21lKHggPT4geCA9PT0gT2JqZWN0KHgpKVxuICAgICk7XG5cbiAgICBpZiAoIShzaW1wbGVSYW5nZSB8fCBzaW1wbGVJbmNsdXNpb24gfHwgc2ltcGxlRXF1YWxpdHkpKSB7XG4gICAgICBtYXRjaGVyLl9pc1NpbXBsZSA9IGZhbHNlO1xuICAgIH1cblxuICAgIGlmIChoYXNPd24uY2FsbChWQUxVRV9PUEVSQVRPUlMsIG9wZXJhdG9yKSkge1xuICAgICAgcmV0dXJuIFZBTFVFX09QRVJBVE9SU1tvcGVyYXRvcl0ob3BlcmFuZCwgdmFsdWVTZWxlY3RvciwgbWF0Y2hlciwgaXNSb290KTtcbiAgICB9XG5cbiAgICBpZiAoaGFzT3duLmNhbGwoRUxFTUVOVF9PUEVSQVRPUlMsIG9wZXJhdG9yKSkge1xuICAgICAgY29uc3Qgb3B0aW9ucyA9IEVMRU1FTlRfT1BFUkFUT1JTW29wZXJhdG9yXTtcbiAgICAgIHJldHVybiBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlcihcbiAgICAgICAgb3B0aW9ucy5jb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIpLFxuICAgICAgICBvcHRpb25zXG4gICAgICApO1xuICAgIH1cblxuICAgIHRocm93IG5ldyBFcnJvcihgVW5yZWNvZ25pemVkIG9wZXJhdG9yOiAke29wZXJhdG9yfWApO1xuICB9KTtcblxuICByZXR1cm4gYW5kQnJhbmNoZWRNYXRjaGVycyhvcGVyYXRvck1hdGNoZXJzKTtcbn1cblxuLy8gcGF0aHMgLSBBcnJheTogbGlzdCBvZiBtb25nbyBzdHlsZSBwYXRoc1xuLy8gbmV3TGVhZkZuIC0gRnVuY3Rpb246IG9mIGZvcm0gZnVuY3Rpb24ocGF0aCkgc2hvdWxkIHJldHVybiBhIHNjYWxhciB2YWx1ZSB0b1xuLy8gICAgICAgICAgICAgICAgICAgICAgIHB1dCBpbnRvIGxpc3QgY3JlYXRlZCBmb3IgdGhhdCBwYXRoXG4vLyBjb25mbGljdEZuIC0gRnVuY3Rpb246IG9mIGZvcm0gZnVuY3Rpb24obm9kZSwgcGF0aCwgZnVsbFBhdGgpIGlzIGNhbGxlZFxuLy8gICAgICAgICAgICAgICAgICAgICAgICB3aGVuIGJ1aWxkaW5nIGEgdHJlZSBwYXRoIGZvciAnZnVsbFBhdGgnIG5vZGUgb25cbi8vICAgICAgICAgICAgICAgICAgICAgICAgJ3BhdGgnIHdhcyBhbHJlYWR5IGEgbGVhZiB3aXRoIGEgdmFsdWUuIE11c3QgcmV0dXJuIGFcbi8vICAgICAgICAgICAgICAgICAgICAgICAgY29uZmxpY3QgcmVzb2x1dGlvbi5cbi8vIGluaXRpYWwgdHJlZSAtIE9wdGlvbmFsIE9iamVjdDogc3RhcnRpbmcgdHJlZS5cbi8vIEByZXR1cm5zIC0gT2JqZWN0OiB0cmVlIHJlcHJlc2VudGVkIGFzIGEgc2V0IG9mIG5lc3RlZCBvYmplY3RzXG5leHBvcnQgZnVuY3Rpb24gcGF0aHNUb1RyZWUocGF0aHMsIG5ld0xlYWZGbiwgY29uZmxpY3RGbiwgcm9vdCA9IHt9KSB7XG4gIHBhdGhzLmZvckVhY2gocGF0aCA9PiB7XG4gICAgY29uc3QgcGF0aEFycmF5ID0gcGF0aC5zcGxpdCgnLicpO1xuICAgIGxldCB0cmVlID0gcm9vdDtcblxuICAgIC8vIHVzZSAuZXZlcnkganVzdCBmb3IgaXRlcmF0aW9uIHdpdGggYnJlYWtcbiAgICBjb25zdCBzdWNjZXNzID0gcGF0aEFycmF5LnNsaWNlKDAsIC0xKS5ldmVyeSgoa2V5LCBpKSA9PiB7XG4gICAgICBpZiAoIWhhc093bi5jYWxsKHRyZWUsIGtleSkpIHtcbiAgICAgICAgdHJlZVtrZXldID0ge307XG4gICAgICB9IGVsc2UgaWYgKHRyZWVba2V5XSAhPT0gT2JqZWN0KHRyZWVba2V5XSkpIHtcbiAgICAgICAgdHJlZVtrZXldID0gY29uZmxpY3RGbihcbiAgICAgICAgICB0cmVlW2tleV0sXG4gICAgICAgICAgcGF0aEFycmF5LnNsaWNlKDAsIGkgKyAxKS5qb2luKCcuJyksXG4gICAgICAgICAgcGF0aFxuICAgICAgICApO1xuXG4gICAgICAgIC8vIGJyZWFrIG91dCBvZiBsb29wIGlmIHdlIGFyZSBmYWlsaW5nIGZvciB0aGlzIHBhdGhcbiAgICAgICAgaWYgKHRyZWVba2V5XSAhPT0gT2JqZWN0KHRyZWVba2V5XSkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdHJlZSA9IHRyZWVba2V5XTtcblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG5cbiAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgY29uc3QgbGFzdEtleSA9IHBhdGhBcnJheVtwYXRoQXJyYXkubGVuZ3RoIC0gMV07XG4gICAgICBpZiAoaGFzT3duLmNhbGwodHJlZSwgbGFzdEtleSkpIHtcbiAgICAgICAgdHJlZVtsYXN0S2V5XSA9IGNvbmZsaWN0Rm4odHJlZVtsYXN0S2V5XSwgcGF0aCwgcGF0aCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cmVlW2xhc3RLZXldID0gbmV3TGVhZkZuKHBhdGgpO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHJvb3Q7XG59XG5cbi8vIE1ha2VzIHN1cmUgd2UgZ2V0IDIgZWxlbWVudHMgYXJyYXkgYW5kIGFzc3VtZSB0aGUgZmlyc3Qgb25lIHRvIGJlIHggYW5kXG4vLyB0aGUgc2Vjb25kIG9uZSB0byB5IG5vIG1hdHRlciB3aGF0IHVzZXIgcGFzc2VzLlxuLy8gSW4gY2FzZSB1c2VyIHBhc3NlcyB7IGxvbjogeCwgbGF0OiB5IH0gcmV0dXJucyBbeCwgeV1cbmZ1bmN0aW9uIHBvaW50VG9BcnJheShwb2ludCkge1xuICByZXR1cm4gQXJyYXkuaXNBcnJheShwb2ludCkgPyBwb2ludC5zbGljZSgpIDogW3BvaW50LngsIHBvaW50LnldO1xufVxuXG4vLyBDcmVhdGluZyBhIGRvY3VtZW50IGZyb20gYW4gdXBzZXJ0IGlzIHF1aXRlIHRyaWNreS5cbi8vIEUuZy4gdGhpcyBzZWxlY3Rvcjoge1wiJG9yXCI6IFt7XCJiLmZvb1wiOiB7XCIkYWxsXCI6IFtcImJhclwiXX19XX0sIHNob3VsZCByZXN1bHRcbi8vIGluOiB7XCJiLmZvb1wiOiBcImJhclwifVxuLy8gQnV0IHRoaXMgc2VsZWN0b3I6IHtcIiRvclwiOiBbe1wiYlwiOiB7XCJmb29cIjoge1wiJGFsbFwiOiBbXCJiYXJcIl19fX1dfSBzaG91bGQgdGhyb3dcbi8vIGFuIGVycm9yXG5cbi8vIFNvbWUgcnVsZXMgKGZvdW5kIG1haW5seSB3aXRoIHRyaWFsICYgZXJyb3IsIHNvIHRoZXJlIG1pZ2h0IGJlIG1vcmUpOlxuLy8gLSBoYW5kbGUgYWxsIGNoaWxkcyBvZiAkYW5kIChvciBpbXBsaWNpdCAkYW5kKVxuLy8gLSBoYW5kbGUgJG9yIG5vZGVzIHdpdGggZXhhY3RseSAxIGNoaWxkXG4vLyAtIGlnbm9yZSAkb3Igbm9kZXMgd2l0aCBtb3JlIHRoYW4gMSBjaGlsZFxuLy8gLSBpZ25vcmUgJG5vciBhbmQgJG5vdCBub2Rlc1xuLy8gLSB0aHJvdyB3aGVuIGEgdmFsdWUgY2FuIG5vdCBiZSBzZXQgdW5hbWJpZ3VvdXNseVxuLy8gLSBldmVyeSB2YWx1ZSBmb3IgJGFsbCBzaG91bGQgYmUgZGVhbHQgd2l0aCBhcyBzZXBhcmF0ZSAkZXEtc1xuLy8gLSB0aHJlYXQgYWxsIGNoaWxkcmVuIG9mICRhbGwgYXMgJGVxIHNldHRlcnMgKD0+IHNldCBpZiAkYWxsLmxlbmd0aCA9PT0gMSxcbi8vICAgb3RoZXJ3aXNlIHRocm93IGVycm9yKVxuLy8gLSB5b3UgY2FuIG5vdCBtaXggJyQnLXByZWZpeGVkIGtleXMgYW5kIG5vbi0nJCctcHJlZml4ZWQga2V5c1xuLy8gLSB5b3UgY2FuIG9ubHkgaGF2ZSBkb3R0ZWQga2V5cyBvbiBhIHJvb3QtbGV2ZWxcbi8vIC0geW91IGNhbiBub3QgaGF2ZSAnJCctcHJlZml4ZWQga2V5cyBtb3JlIHRoYW4gb25lLWxldmVsIGRlZXAgaW4gYW4gb2JqZWN0XG5cbi8vIEhhbmRsZXMgb25lIGtleS92YWx1ZSBwYWlyIHRvIHB1dCBpbiB0aGUgc2VsZWN0b3IgZG9jdW1lbnRcbmZ1bmN0aW9uIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgdmFsdWUpIHtcbiAgaWYgKHZhbHVlICYmIE9iamVjdC5nZXRQcm90b3R5cGVPZih2YWx1ZSkgPT09IE9iamVjdC5wcm90b3R5cGUpIHtcbiAgICBwb3B1bGF0ZURvY3VtZW50V2l0aE9iamVjdChkb2N1bWVudCwga2V5LCB2YWx1ZSk7XG4gIH0gZWxzZSBpZiAoISh2YWx1ZSBpbnN0YW5jZW9mIFJlZ0V4cCkpIHtcbiAgICBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsIGtleSwgdmFsdWUpO1xuICB9XG59XG5cbi8vIEhhbmRsZXMgYSBrZXksIHZhbHVlIHBhaXIgdG8gcHV0IGluIHRoZSBzZWxlY3RvciBkb2N1bWVudFxuLy8gaWYgdGhlIHZhbHVlIGlzIGFuIG9iamVjdFxuZnVuY3Rpb24gcG9wdWxhdGVEb2N1bWVudFdpdGhPYmplY3QoZG9jdW1lbnQsIGtleSwgdmFsdWUpIHtcbiAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKHZhbHVlKTtcbiAgY29uc3QgdW5wcmVmaXhlZEtleXMgPSBrZXlzLmZpbHRlcihvcCA9PiBvcFswXSAhPT0gJyQnKTtcblxuICBpZiAodW5wcmVmaXhlZEtleXMubGVuZ3RoID4gMCB8fCAha2V5cy5sZW5ndGgpIHtcbiAgICAvLyBMaXRlcmFsIChwb3NzaWJseSBlbXB0eSkgb2JqZWN0ICggb3IgZW1wdHkgb2JqZWN0IClcbiAgICAvLyBEb24ndCBhbGxvdyBtaXhpbmcgJyQnLXByZWZpeGVkIHdpdGggbm9uLSckJy1wcmVmaXhlZCBmaWVsZHNcbiAgICBpZiAoa2V5cy5sZW5ndGggIT09IHVucHJlZml4ZWRLZXlzLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIG9wZXJhdG9yOiAke3VucHJlZml4ZWRLZXlzWzBdfWApO1xuICAgIH1cblxuICAgIHZhbGlkYXRlT2JqZWN0KHZhbHVlLCBrZXkpO1xuICAgIGluc2VydEludG9Eb2N1bWVudChkb2N1bWVudCwga2V5LCB2YWx1ZSk7XG4gIH0gZWxzZSB7XG4gICAgT2JqZWN0LmtleXModmFsdWUpLmZvckVhY2gob3AgPT4ge1xuICAgICAgY29uc3Qgb2JqZWN0ID0gdmFsdWVbb3BdO1xuXG4gICAgICBpZiAob3AgPT09ICckZXEnKSB7XG4gICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgb2JqZWN0KTtcbiAgICAgIH0gZWxzZSBpZiAob3AgPT09ICckYWxsJykge1xuICAgICAgICAvLyBldmVyeSB2YWx1ZSBmb3IgJGFsbCBzaG91bGQgYmUgZGVhbHQgd2l0aCBhcyBzZXBhcmF0ZSAkZXEtc1xuICAgICAgICBvYmplY3QuZm9yRWFjaChlbGVtZW50ID0+XG4gICAgICAgICAgcG9wdWxhdGVEb2N1bWVudFdpdGhLZXlWYWx1ZShkb2N1bWVudCwga2V5LCBlbGVtZW50KVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG59XG5cbi8vIEZpbGxzIGEgZG9jdW1lbnQgd2l0aCBjZXJ0YWluIGZpZWxkcyBmcm9tIGFuIHVwc2VydCBzZWxlY3RvclxuZXhwb3J0IGZ1bmN0aW9uIHBvcHVsYXRlRG9jdW1lbnRXaXRoUXVlcnlGaWVsZHMocXVlcnksIGRvY3VtZW50ID0ge30pIHtcbiAgaWYgKE9iamVjdC5nZXRQcm90b3R5cGVPZihxdWVyeSkgPT09IE9iamVjdC5wcm90b3R5cGUpIHtcbiAgICAvLyBoYW5kbGUgaW1wbGljaXQgJGFuZFxuICAgIE9iamVjdC5rZXlzKHF1ZXJ5KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHF1ZXJ5W2tleV07XG5cbiAgICAgIGlmIChrZXkgPT09ICckYW5kJykge1xuICAgICAgICAvLyBoYW5kbGUgZXhwbGljaXQgJGFuZFxuICAgICAgICB2YWx1ZS5mb3JFYWNoKGVsZW1lbnQgPT5cbiAgICAgICAgICBwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzKGVsZW1lbnQsIGRvY3VtZW50KVxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChrZXkgPT09ICckb3InKSB7XG4gICAgICAgIC8vIGhhbmRsZSAkb3Igbm9kZXMgd2l0aCBleGFjdGx5IDEgY2hpbGRcbiAgICAgICAgaWYgKHZhbHVlLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoUXVlcnlGaWVsZHModmFsdWVbMF0sIGRvY3VtZW50KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChrZXlbMF0gIT09ICckJykge1xuICAgICAgICAvLyBJZ25vcmUgb3RoZXIgJyQnLXByZWZpeGVkIGxvZ2ljYWwgc2VsZWN0b3JzXG4gICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgdmFsdWUpO1xuICAgICAgfVxuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIC8vIEhhbmRsZSBtZXRlb3Itc3BlY2lmaWMgc2hvcnRjdXQgZm9yIHNlbGVjdGluZyBfaWRcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQocXVlcnkpKSB7XG4gICAgICBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsICdfaWQnLCBxdWVyeSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGRvY3VtZW50O1xufVxuXG4vLyBUcmF2ZXJzZXMgdGhlIGtleXMgb2YgcGFzc2VkIHByb2plY3Rpb24gYW5kIGNvbnN0cnVjdHMgYSB0cmVlIHdoZXJlIGFsbFxuLy8gbGVhdmVzIGFyZSBlaXRoZXIgYWxsIFRydWUgb3IgYWxsIEZhbHNlXG4vLyBAcmV0dXJucyBPYmplY3Q6XG4vLyAgLSB0cmVlIC0gT2JqZWN0IC0gdHJlZSByZXByZXNlbnRhdGlvbiBvZiBrZXlzIGludm9sdmVkIGluIHByb2plY3Rpb25cbi8vICAoZXhjZXB0aW9uIGZvciAnX2lkJyBhcyBpdCBpcyBhIHNwZWNpYWwgY2FzZSBoYW5kbGVkIHNlcGFyYXRlbHkpXG4vLyAgLSBpbmNsdWRpbmcgLSBCb29sZWFuIC0gXCJ0YWtlIG9ubHkgY2VydGFpbiBmaWVsZHNcIiB0eXBlIG9mIHByb2plY3Rpb25cbmV4cG9ydCBmdW5jdGlvbiBwcm9qZWN0aW9uRGV0YWlscyhmaWVsZHMpIHtcbiAgLy8gRmluZCB0aGUgbm9uLV9pZCBrZXlzIChfaWQgaXMgaGFuZGxlZCBzcGVjaWFsbHkgYmVjYXVzZSBpdCBpcyBpbmNsdWRlZFxuICAvLyB1bmxlc3MgZXhwbGljaXRseSBleGNsdWRlZCkuIFNvcnQgdGhlIGtleXMsIHNvIHRoYXQgb3VyIGNvZGUgdG8gZGV0ZWN0XG4gIC8vIG92ZXJsYXBzIGxpa2UgJ2ZvbycgYW5kICdmb28uYmFyJyBjYW4gYXNzdW1lIHRoYXQgJ2ZvbycgY29tZXMgZmlyc3QuXG4gIGxldCBmaWVsZHNLZXlzID0gT2JqZWN0LmtleXMoZmllbGRzKS5zb3J0KCk7XG5cbiAgLy8gSWYgX2lkIGlzIHRoZSBvbmx5IGZpZWxkIGluIHRoZSBwcm9qZWN0aW9uLCBkbyBub3QgcmVtb3ZlIGl0LCBzaW5jZSBpdCBpc1xuICAvLyByZXF1aXJlZCB0byBkZXRlcm1pbmUgaWYgdGhpcyBpcyBhbiBleGNsdXNpb24gb3IgZXhjbHVzaW9uLiBBbHNvIGtlZXAgYW5cbiAgLy8gaW5jbHVzaXZlIF9pZCwgc2luY2UgaW5jbHVzaXZlIF9pZCBmb2xsb3dzIHRoZSBub3JtYWwgcnVsZXMgYWJvdXQgbWl4aW5nXG4gIC8vIGluY2x1c2l2ZSBhbmQgZXhjbHVzaXZlIGZpZWxkcy4gSWYgX2lkIGlzIG5vdCB0aGUgb25seSBmaWVsZCBpbiB0aGVcbiAgLy8gcHJvamVjdGlvbiBhbmQgaXMgZXhjbHVzaXZlLCByZW1vdmUgaXQgc28gaXQgY2FuIGJlIGhhbmRsZWQgbGF0ZXIgYnkgYVxuICAvLyBzcGVjaWFsIGNhc2UsIHNpbmNlIGV4Y2x1c2l2ZSBfaWQgaXMgYWx3YXlzIGFsbG93ZWQuXG4gIGlmICghKGZpZWxkc0tleXMubGVuZ3RoID09PSAxICYmIGZpZWxkc0tleXNbMF0gPT09ICdfaWQnKSAmJlxuICAgICAgIShmaWVsZHNLZXlzLmluY2x1ZGVzKCdfaWQnKSAmJiBmaWVsZHMuX2lkKSkge1xuICAgIGZpZWxkc0tleXMgPSBmaWVsZHNLZXlzLmZpbHRlcihrZXkgPT4ga2V5ICE9PSAnX2lkJyk7XG4gIH1cblxuICBsZXQgaW5jbHVkaW5nID0gbnVsbDsgLy8gVW5rbm93blxuXG4gIGZpZWxkc0tleXMuZm9yRWFjaChrZXlQYXRoID0+IHtcbiAgICBjb25zdCBydWxlID0gISFmaWVsZHNba2V5UGF0aF07XG5cbiAgICBpZiAoaW5jbHVkaW5nID09PSBudWxsKSB7XG4gICAgICBpbmNsdWRpbmcgPSBydWxlO1xuICAgIH1cblxuICAgIC8vIFRoaXMgZXJyb3IgbWVzc2FnZSBpcyBjb3BpZWQgZnJvbSBNb25nb0RCIHNoZWxsXG4gICAgaWYgKGluY2x1ZGluZyAhPT0gcnVsZSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdZb3UgY2Fubm90IGN1cnJlbnRseSBtaXggaW5jbHVkaW5nIGFuZCBleGNsdWRpbmcgZmllbGRzLidcbiAgICAgICk7XG4gICAgfVxuICB9KTtcblxuICBjb25zdCBwcm9qZWN0aW9uUnVsZXNUcmVlID0gcGF0aHNUb1RyZWUoXG4gICAgZmllbGRzS2V5cyxcbiAgICBwYXRoID0+IGluY2x1ZGluZyxcbiAgICAobm9kZSwgcGF0aCwgZnVsbFBhdGgpID0+IHtcbiAgICAgIC8vIENoZWNrIHBhc3NlZCBwcm9qZWN0aW9uIGZpZWxkcycga2V5czogSWYgeW91IGhhdmUgdHdvIHJ1bGVzIHN1Y2ggYXNcbiAgICAgIC8vICdmb28uYmFyJyBhbmQgJ2Zvby5iYXIuYmF6JywgdGhlbiB0aGUgcmVzdWx0IGJlY29tZXMgYW1iaWd1b3VzLiBJZlxuICAgICAgLy8gdGhhdCBoYXBwZW5zLCB0aGVyZSBpcyBhIHByb2JhYmlsaXR5IHlvdSBhcmUgZG9pbmcgc29tZXRoaW5nIHdyb25nLFxuICAgICAgLy8gZnJhbWV3b3JrIHNob3VsZCBub3RpZnkgeW91IGFib3V0IHN1Y2ggbWlzdGFrZSBlYXJsaWVyIG9uIGN1cnNvclxuICAgICAgLy8gY29tcGlsYXRpb24gc3RlcCB0aGFuIGxhdGVyIGR1cmluZyBydW50aW1lLiAgTm90ZSwgdGhhdCByZWFsIG1vbmdvXG4gICAgICAvLyBkb2Vzbid0IGRvIGFueXRoaW5nIGFib3V0IGl0IGFuZCB0aGUgbGF0ZXIgcnVsZSBhcHBlYXJzIGluIHByb2plY3Rpb25cbiAgICAgIC8vIHByb2plY3QsIG1vcmUgcHJpb3JpdHkgaXQgdGFrZXMuXG4gICAgICAvL1xuICAgICAgLy8gRXhhbXBsZSwgYXNzdW1lIGZvbGxvd2luZyBpbiBtb25nbyBzaGVsbDpcbiAgICAgIC8vID4gZGIuY29sbC5pbnNlcnQoeyBhOiB7IGI6IDIzLCBjOiA0NCB9IH0pXG4gICAgICAvLyA+IGRiLmNvbGwuZmluZCh7fSwgeyAnYSc6IDEsICdhLmInOiAxIH0pXG4gICAgICAvLyB7XCJfaWRcIjogT2JqZWN0SWQoXCI1MjBiZmU0NTYwMjQ2MDhlOGVmMjRhZjNcIiksIFwiYVwiOiB7XCJiXCI6IDIzfX1cbiAgICAgIC8vID4gZGIuY29sbC5maW5kKHt9LCB7ICdhLmInOiAxLCAnYSc6IDEgfSlcbiAgICAgIC8vIHtcIl9pZFwiOiBPYmplY3RJZChcIjUyMGJmZTQ1NjAyNDYwOGU4ZWYyNGFmM1wiKSwgXCJhXCI6IHtcImJcIjogMjMsIFwiY1wiOiA0NH19XG4gICAgICAvL1xuICAgICAgLy8gTm90ZSwgaG93IHNlY29uZCB0aW1lIHRoZSByZXR1cm4gc2V0IG9mIGtleXMgaXMgZGlmZmVyZW50LlxuICAgICAgY29uc3QgY3VycmVudFBhdGggPSBmdWxsUGF0aDtcbiAgICAgIGNvbnN0IGFub3RoZXJQYXRoID0gcGF0aDtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICBgYm90aCAke2N1cnJlbnRQYXRofSBhbmQgJHthbm90aGVyUGF0aH0gZm91bmQgaW4gZmllbGRzIG9wdGlvbiwgYCArXG4gICAgICAgICd1c2luZyBib3RoIG9mIHRoZW0gbWF5IHRyaWdnZXIgdW5leHBlY3RlZCBiZWhhdmlvci4gRGlkIHlvdSBtZWFuIHRvICcgK1xuICAgICAgICAndXNlIG9ubHkgb25lIG9mIHRoZW0/J1xuICAgICAgKTtcbiAgICB9KTtcblxuICByZXR1cm4ge2luY2x1ZGluZywgdHJlZTogcHJvamVjdGlvblJ1bGVzVHJlZX07XG59XG5cbi8vIFRha2VzIGEgUmVnRXhwIG9iamVjdCBhbmQgcmV0dXJucyBhbiBlbGVtZW50IG1hdGNoZXIuXG5leHBvcnQgZnVuY3Rpb24gcmVnZXhwRWxlbWVudE1hdGNoZXIocmVnZXhwKSB7XG4gIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICByZXR1cm4gdmFsdWUudG9TdHJpbmcoKSA9PT0gcmVnZXhwLnRvU3RyaW5nKCk7XG4gICAgfVxuXG4gICAgLy8gUmVnZXhwcyBvbmx5IHdvcmsgYWdhaW5zdCBzdHJpbmdzLlxuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgLy8gUmVzZXQgcmVnZXhwJ3Mgc3RhdGUgdG8gYXZvaWQgaW5jb25zaXN0ZW50IG1hdGNoaW5nIGZvciBvYmplY3RzIHdpdGggdGhlXG4gICAgLy8gc2FtZSB2YWx1ZSBvbiBjb25zZWN1dGl2ZSBjYWxscyBvZiByZWdleHAudGVzdC4gVGhpcyBoYXBwZW5zIG9ubHkgaWYgdGhlXG4gICAgLy8gcmVnZXhwIGhhcyB0aGUgJ2cnIGZsYWcuIEFsc28gbm90ZSB0aGF0IEVTNiBpbnRyb2R1Y2VzIGEgbmV3IGZsYWcgJ3knIGZvclxuICAgIC8vIHdoaWNoIHdlIHNob3VsZCAqbm90KiBjaGFuZ2UgdGhlIGxhc3RJbmRleCBidXQgTW9uZ29EQiBkb2Vzbid0IHN1cHBvcnRcbiAgICAvLyBlaXRoZXIgb2YgdGhlc2UgZmxhZ3MuXG4gICAgcmVnZXhwLmxhc3RJbmRleCA9IDA7XG5cbiAgICByZXR1cm4gcmVnZXhwLnRlc3QodmFsdWUpO1xuICB9O1xufVxuXG4vLyBWYWxpZGF0ZXMgdGhlIGtleSBpbiBhIHBhdGguXG4vLyBPYmplY3RzIHRoYXQgYXJlIG5lc3RlZCBtb3JlIHRoZW4gMSBsZXZlbCBjYW5ub3QgaGF2ZSBkb3R0ZWQgZmllbGRzXG4vLyBvciBmaWVsZHMgc3RhcnRpbmcgd2l0aCAnJCdcbmZ1bmN0aW9uIHZhbGlkYXRlS2V5SW5QYXRoKGtleSwgcGF0aCkge1xuICBpZiAoa2V5LmluY2x1ZGVzKCcuJykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVGhlIGRvdHRlZCBmaWVsZCAnJHtrZXl9JyBpbiAnJHtwYXRofS4ke2tleX0gaXMgbm90IHZhbGlkIGZvciBzdG9yYWdlLmBcbiAgICApO1xuICB9XG5cbiAgaWYgKGtleVswXSA9PT0gJyQnKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFRoZSBkb2xsYXIgKCQpIHByZWZpeGVkIGZpZWxkICAnJHtwYXRofS4ke2tleX0gaXMgbm90IHZhbGlkIGZvciBzdG9yYWdlLmBcbiAgICApO1xuICB9XG59XG5cbi8vIFJlY3Vyc2l2ZWx5IHZhbGlkYXRlcyBhbiBvYmplY3QgdGhhdCBpcyBuZXN0ZWQgbW9yZSB0aGFuIG9uZSBsZXZlbCBkZWVwXG5mdW5jdGlvbiB2YWxpZGF0ZU9iamVjdChvYmplY3QsIHBhdGgpIHtcbiAgaWYgKG9iamVjdCAmJiBPYmplY3QuZ2V0UHJvdG90eXBlT2Yob2JqZWN0KSA9PT0gT2JqZWN0LnByb3RvdHlwZSkge1xuICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgdmFsaWRhdGVLZXlJblBhdGgoa2V5LCBwYXRoKTtcbiAgICAgIHZhbGlkYXRlT2JqZWN0KG9iamVjdFtrZXldLCBwYXRoICsgJy4nICsga2V5KTtcbiAgICB9KTtcbiAgfVxufVxuIiwiaW1wb3J0IExvY2FsQ29sbGVjdGlvbiBmcm9tICcuL2xvY2FsX2NvbGxlY3Rpb24uanMnO1xuaW1wb3J0IHsgaGFzT3duIH0gZnJvbSAnLi9jb21tb24uanMnO1xuXG4vLyBDdXJzb3I6IGEgc3BlY2lmaWNhdGlvbiBmb3IgYSBwYXJ0aWN1bGFyIHN1YnNldCBvZiBkb2N1bWVudHMsIHcvIGEgZGVmaW5lZFxuLy8gb3JkZXIsIGxpbWl0LCBhbmQgb2Zmc2V0LiAgY3JlYXRpbmcgYSBDdXJzb3Igd2l0aCBMb2NhbENvbGxlY3Rpb24uZmluZCgpLFxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgQ3Vyc29yIHtcbiAgLy8gZG9uJ3QgY2FsbCB0aGlzIGN0b3IgZGlyZWN0bHkuICB1c2UgTG9jYWxDb2xsZWN0aW9uLmZpbmQoKS5cbiAgY29uc3RydWN0b3IoY29sbGVjdGlvbiwgc2VsZWN0b3IsIG9wdGlvbnMgPSB7fSkge1xuICAgIHRoaXMuY29sbGVjdGlvbiA9IGNvbGxlY3Rpb247XG4gICAgdGhpcy5zb3J0ZXIgPSBudWxsO1xuICAgIHRoaXMubWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3Rvcik7XG5cbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWRQZXJoYXBzQXNPYmplY3Qoc2VsZWN0b3IpKSB7XG4gICAgICAvLyBzdGFzaCBmb3IgZmFzdCBfaWQgYW5kIHsgX2lkIH1cbiAgICAgIHRoaXMuX3NlbGVjdG9ySWQgPSBoYXNPd24uY2FsbChzZWxlY3RvciwgJ19pZCcpXG4gICAgICAgID8gc2VsZWN0b3IuX2lkXG4gICAgICAgIDogc2VsZWN0b3I7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX3NlbGVjdG9ySWQgPSB1bmRlZmluZWQ7XG5cbiAgICAgIGlmICh0aGlzLm1hdGNoZXIuaGFzR2VvUXVlcnkoKSB8fCBvcHRpb25zLnNvcnQpIHtcbiAgICAgICAgdGhpcy5zb3J0ZXIgPSBuZXcgTWluaW1vbmdvLlNvcnRlcihvcHRpb25zLnNvcnQgfHwgW10pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHRoaXMuc2tpcCA9IG9wdGlvbnMuc2tpcCB8fCAwO1xuICAgIHRoaXMubGltaXQgPSBvcHRpb25zLmxpbWl0O1xuICAgIHRoaXMuZmllbGRzID0gb3B0aW9ucy5maWVsZHM7XG5cbiAgICB0aGlzLl9wcm9qZWN0aW9uRm4gPSBMb2NhbENvbGxlY3Rpb24uX2NvbXBpbGVQcm9qZWN0aW9uKHRoaXMuZmllbGRzIHx8IHt9KTtcblxuICAgIHRoaXMuX3RyYW5zZm9ybSA9IExvY2FsQ29sbGVjdGlvbi53cmFwVHJhbnNmb3JtKG9wdGlvbnMudHJhbnNmb3JtKTtcblxuICAgIC8vIGJ5IGRlZmF1bHQsIHF1ZXJpZXMgcmVnaXN0ZXIgdy8gVHJhY2tlciB3aGVuIGl0IGlzIGF2YWlsYWJsZS5cbiAgICBpZiAodHlwZW9mIFRyYWNrZXIgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aGlzLnJlYWN0aXZlID0gb3B0aW9ucy5yZWFjdGl2ZSA9PT0gdW5kZWZpbmVkID8gdHJ1ZSA6IG9wdGlvbnMucmVhY3RpdmU7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJldHVybnMgdGhlIG51bWJlciBvZiBkb2N1bWVudHMgdGhhdCBtYXRjaCBhIHF1ZXJ5LlxuICAgKiBAbWVtYmVyT2YgTW9uZ28uQ3Vyc29yXG4gICAqIEBtZXRob2QgIGNvdW50XG4gICAqIEBwYXJhbSB7Ym9vbGVhbn0gW2FwcGx5U2tpcExpbWl0PXRydWVdIElmIHNldCB0byBgZmFsc2VgLCB0aGUgdmFsdWVcbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybmVkIHdpbGwgcmVmbGVjdCB0aGUgdG90YWxcbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG51bWJlciBvZiBtYXRjaGluZyBkb2N1bWVudHMsXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZ25vcmluZyBhbnkgdmFsdWUgc3VwcGxpZWQgZm9yXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaW1pdFxuICAgKiBAaW5zdGFuY2VcbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEByZXR1cm5zIHtOdW1iZXJ9XG4gICAqL1xuICBjb3VudChhcHBseVNraXBMaW1pdCA9IHRydWUpIHtcbiAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgLy8gYWxsb3cgdGhlIG9ic2VydmUgdG8gYmUgdW5vcmRlcmVkXG4gICAgICB0aGlzLl9kZXBlbmQoe2FkZGVkOiB0cnVlLCByZW1vdmVkOiB0cnVlfSwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuX2dldFJhd09iamVjdHMoe1xuICAgICAgb3JkZXJlZDogdHJ1ZSxcbiAgICAgIGFwcGx5U2tpcExpbWl0XG4gICAgfSkubGVuZ3RoO1xuICB9XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJldHVybiBhbGwgbWF0Y2hpbmcgZG9jdW1lbnRzIGFzIGFuIEFycmF5LlxuICAgKiBAbWVtYmVyT2YgTW9uZ28uQ3Vyc29yXG4gICAqIEBtZXRob2QgIGZldGNoXG4gICAqIEBpbnN0YW5jZVxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQHJldHVybnMge09iamVjdFtdfVxuICAgKi9cbiAgZmV0Y2goKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gW107XG5cbiAgICB0aGlzLmZvckVhY2goZG9jID0+IHtcbiAgICAgIHJlc3VsdC5wdXNoKGRvYyk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgW1N5bWJvbC5pdGVyYXRvcl0oKSB7XG4gICAgaWYgKHRoaXMucmVhY3RpdmUpIHtcbiAgICAgIHRoaXMuX2RlcGVuZCh7XG4gICAgICAgIGFkZGVkQmVmb3JlOiB0cnVlLFxuICAgICAgICByZW1vdmVkOiB0cnVlLFxuICAgICAgICBjaGFuZ2VkOiB0cnVlLFxuICAgICAgICBtb3ZlZEJlZm9yZTogdHJ1ZX0pO1xuICAgIH1cblxuICAgIGxldCBpbmRleCA9IDA7XG4gICAgY29uc3Qgb2JqZWN0cyA9IHRoaXMuX2dldFJhd09iamVjdHMoe29yZGVyZWQ6IHRydWV9KTtcblxuICAgIHJldHVybiB7XG4gICAgICBuZXh0OiAoKSA9PiB7XG4gICAgICAgIGlmIChpbmRleCA8IG9iamVjdHMubGVuZ3RoKSB7XG4gICAgICAgICAgLy8gVGhpcyBkb3VibGVzIGFzIGEgY2xvbmUgb3BlcmF0aW9uLlxuICAgICAgICAgIGxldCBlbGVtZW50ID0gdGhpcy5fcHJvamVjdGlvbkZuKG9iamVjdHNbaW5kZXgrK10pO1xuXG4gICAgICAgICAgaWYgKHRoaXMuX3RyYW5zZm9ybSlcbiAgICAgICAgICAgIGVsZW1lbnQgPSB0aGlzLl90cmFuc2Zvcm0oZWxlbWVudCk7XG5cbiAgICAgICAgICByZXR1cm4ge3ZhbHVlOiBlbGVtZW50fTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7ZG9uZTogdHJ1ZX07XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBAY2FsbGJhY2sgSXRlcmF0aW9uQ2FsbGJhY2tcbiAgICogQHBhcmFtIHtPYmplY3R9IGRvY1xuICAgKiBAcGFyYW0ge051bWJlcn0gaW5kZXhcbiAgICovXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGBjYWxsYmFja2Agb25jZSBmb3IgZWFjaCBtYXRjaGluZyBkb2N1bWVudCwgc2VxdWVudGlhbGx5IGFuZFxuICAgKiAgICAgICAgICBzeW5jaHJvbm91c2x5LlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCAgZm9yRWFjaFxuICAgKiBAaW5zdGFuY2VcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAcGFyYW0ge0l0ZXJhdGlvbkNhbGxiYWNrfSBjYWxsYmFjayBGdW5jdGlvbiB0byBjYWxsLiBJdCB3aWxsIGJlIGNhbGxlZFxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoIHRocmVlIGFyZ3VtZW50czogdGhlIGRvY3VtZW50LCBhXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAtYmFzZWQgaW5kZXgsIGFuZCA8ZW0+Y3Vyc29yPC9lbT5cbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXRzZWxmLlxuICAgKiBAcGFyYW0ge0FueX0gW3RoaXNBcmddIEFuIG9iamVjdCB3aGljaCB3aWxsIGJlIHRoZSB2YWx1ZSBvZiBgdGhpc2AgaW5zaWRlXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgYGNhbGxiYWNrYC5cbiAgICovXG4gIGZvckVhY2goY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgdGhpcy5fZGVwZW5kKHtcbiAgICAgICAgYWRkZWRCZWZvcmU6IHRydWUsXG4gICAgICAgIHJlbW92ZWQ6IHRydWUsXG4gICAgICAgIGNoYW5nZWQ6IHRydWUsXG4gICAgICAgIG1vdmVkQmVmb3JlOiB0cnVlfSk7XG4gICAgfVxuXG4gICAgdGhpcy5fZ2V0UmF3T2JqZWN0cyh7b3JkZXJlZDogdHJ1ZX0pLmZvckVhY2goKGVsZW1lbnQsIGkpID0+IHtcbiAgICAgIC8vIFRoaXMgZG91YmxlcyBhcyBhIGNsb25lIG9wZXJhdGlvbi5cbiAgICAgIGVsZW1lbnQgPSB0aGlzLl9wcm9qZWN0aW9uRm4oZWxlbWVudCk7XG5cbiAgICAgIGlmICh0aGlzLl90cmFuc2Zvcm0pIHtcbiAgICAgICAgZWxlbWVudCA9IHRoaXMuX3RyYW5zZm9ybShlbGVtZW50KTtcbiAgICAgIH1cblxuICAgICAgY2FsbGJhY2suY2FsbCh0aGlzQXJnLCBlbGVtZW50LCBpLCB0aGlzKTtcbiAgICB9KTtcbiAgfVxuXG4gIGdldFRyYW5zZm9ybSgpIHtcbiAgICByZXR1cm4gdGhpcy5fdHJhbnNmb3JtO1xuICB9XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IE1hcCBjYWxsYmFjayBvdmVyIGFsbCBtYXRjaGluZyBkb2N1bWVudHMuICBSZXR1cm5zIGFuIEFycmF5LlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCBtYXBcbiAgICogQGluc3RhbmNlXG4gICAqIEBtZW1iZXJPZiBNb25nby5DdXJzb3JcbiAgICogQHBhcmFtIHtJdGVyYXRpb25DYWxsYmFja30gY2FsbGJhY2sgRnVuY3Rpb24gdG8gY2FsbC4gSXQgd2lsbCBiZSBjYWxsZWRcbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aCB0aHJlZSBhcmd1bWVudHM6IHRoZSBkb2N1bWVudCwgYVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAwLWJhc2VkIGluZGV4LCBhbmQgPGVtPmN1cnNvcjwvZW0+XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGl0c2VsZi5cbiAgICogQHBhcmFtIHtBbnl9IFt0aGlzQXJnXSBBbiBvYmplY3Qgd2hpY2ggd2lsbCBiZSB0aGUgdmFsdWUgb2YgYHRoaXNgIGluc2lkZVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgIGBjYWxsYmFja2AuXG4gICAqL1xuICBtYXAoY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICBjb25zdCByZXN1bHQgPSBbXTtcblxuICAgIHRoaXMuZm9yRWFjaCgoZG9jLCBpKSA9PiB7XG4gICAgICByZXN1bHQucHVzaChjYWxsYmFjay5jYWxsKHRoaXNBcmcsIGRvYywgaSwgdGhpcykpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIG9wdGlvbnMgdG8gY29udGFpbjpcbiAgLy8gICogY2FsbGJhY2tzIGZvciBvYnNlcnZlKCk6XG4gIC8vICAgIC0gYWRkZWRBdCAoZG9jdW1lbnQsIGF0SW5kZXgpXG4gIC8vICAgIC0gYWRkZWQgKGRvY3VtZW50KVxuICAvLyAgICAtIGNoYW5nZWRBdCAobmV3RG9jdW1lbnQsIG9sZERvY3VtZW50LCBhdEluZGV4KVxuICAvLyAgICAtIGNoYW5nZWQgKG5ld0RvY3VtZW50LCBvbGREb2N1bWVudClcbiAgLy8gICAgLSByZW1vdmVkQXQgKGRvY3VtZW50LCBhdEluZGV4KVxuICAvLyAgICAtIHJlbW92ZWQgKGRvY3VtZW50KVxuICAvLyAgICAtIG1vdmVkVG8gKGRvY3VtZW50LCBvbGRJbmRleCwgbmV3SW5kZXgpXG4gIC8vXG4gIC8vIGF0dHJpYnV0ZXMgYXZhaWxhYmxlIG9uIHJldHVybmVkIHF1ZXJ5IGhhbmRsZTpcbiAgLy8gICogc3RvcCgpOiBlbmQgdXBkYXRlc1xuICAvLyAgKiBjb2xsZWN0aW9uOiB0aGUgY29sbGVjdGlvbiB0aGlzIHF1ZXJ5IGlzIHF1ZXJ5aW5nXG4gIC8vXG4gIC8vIGlmZiB4IGlzIGEgcmV0dXJuZWQgcXVlcnkgaGFuZGxlLCAoeCBpbnN0YW5jZW9mXG4gIC8vIExvY2FsQ29sbGVjdGlvbi5PYnNlcnZlSGFuZGxlKSBpcyB0cnVlXG4gIC8vXG4gIC8vIGluaXRpYWwgcmVzdWx0cyBkZWxpdmVyZWQgdGhyb3VnaCBhZGRlZCBjYWxsYmFja1xuICAvLyBYWFggbWF5YmUgY2FsbGJhY2tzIHNob3VsZCB0YWtlIGEgbGlzdCBvZiBvYmplY3RzLCB0byBleHBvc2UgdHJhbnNhY3Rpb25zP1xuICAvLyBYWFggbWF5YmUgc3VwcG9ydCBmaWVsZCBsaW1pdGluZyAodG8gbGltaXQgd2hhdCB5b3UncmUgbm90aWZpZWQgb24pXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFdhdGNoIGEgcXVlcnkuICBSZWNlaXZlIGNhbGxiYWNrcyBhcyB0aGUgcmVzdWx0IHNldCBjaGFuZ2VzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGNhbGxiYWNrcyBGdW5jdGlvbnMgdG8gY2FsbCB0byBkZWxpdmVyIHRoZSByZXN1bHQgc2V0IGFzIGl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhbmdlc1xuICAgKi9cbiAgb2JzZXJ2ZShvcHRpb25zKSB7XG4gICAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyh0aGlzLCBvcHRpb25zKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBXYXRjaCBhIHF1ZXJ5LiBSZWNlaXZlIGNhbGxiYWNrcyBhcyB0aGUgcmVzdWx0IHNldCBjaGFuZ2VzLiBPbmx5XG4gICAqICAgICAgICAgIHRoZSBkaWZmZXJlbmNlcyBiZXR3ZWVuIHRoZSBvbGQgYW5kIG5ldyBkb2N1bWVudHMgYXJlIHBhc3NlZCB0b1xuICAgKiAgICAgICAgICB0aGUgY2FsbGJhY2tzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGNhbGxiYWNrcyBGdW5jdGlvbnMgdG8gY2FsbCB0byBkZWxpdmVyIHRoZSByZXN1bHQgc2V0IGFzIGl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhbmdlc1xuICAgKi9cbiAgb2JzZXJ2ZUNoYW5nZXMob3B0aW9ucykge1xuICAgIGNvbnN0IG9yZGVyZWQgPSBMb2NhbENvbGxlY3Rpb24uX29ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzQXJlT3JkZXJlZChvcHRpb25zKTtcblxuICAgIC8vIHRoZXJlIGFyZSBzZXZlcmFsIHBsYWNlcyB0aGF0IGFzc3VtZSB5b3UgYXJlbid0IGNvbWJpbmluZyBza2lwL2xpbWl0IHdpdGhcbiAgICAvLyB1bm9yZGVyZWQgb2JzZXJ2ZS4gIGVnLCB1cGRhdGUncyBFSlNPTi5jbG9uZSwgYW5kIHRoZSBcInRoZXJlIGFyZSBzZXZlcmFsXCJcbiAgICAvLyBjb21tZW50IGluIF9tb2RpZnlBbmROb3RpZnlcbiAgICAvLyBYWFggYWxsb3cgc2tpcC9saW1pdCB3aXRoIHVub3JkZXJlZCBvYnNlcnZlXG4gICAgaWYgKCFvcHRpb25zLl9hbGxvd191bm9yZGVyZWQgJiYgIW9yZGVyZWQgJiYgKHRoaXMuc2tpcCB8fCB0aGlzLmxpbWl0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIk11c3QgdXNlIGFuIG9yZGVyZWQgb2JzZXJ2ZSB3aXRoIHNraXAgb3IgbGltaXQgKGkuZS4gJ2FkZGVkQmVmb3JlJyBcIiArXG4gICAgICAgIFwiZm9yIG9ic2VydmVDaGFuZ2VzIG9yICdhZGRlZEF0JyBmb3Igb2JzZXJ2ZSwgaW5zdGVhZCBvZiAnYWRkZWQnKS5cIlxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5maWVsZHMgJiYgKHRoaXMuZmllbGRzLl9pZCA9PT0gMCB8fCB0aGlzLmZpZWxkcy5faWQgPT09IGZhbHNlKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJ1lvdSBtYXkgbm90IG9ic2VydmUgYSBjdXJzb3Igd2l0aCB7ZmllbGRzOiB7X2lkOiAwfX0nKTtcbiAgICB9XG5cbiAgICBjb25zdCBkaXN0YW5jZXMgPSAoXG4gICAgICB0aGlzLm1hdGNoZXIuaGFzR2VvUXVlcnkoKSAmJlxuICAgICAgb3JkZXJlZCAmJlxuICAgICAgbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXBcbiAgICApO1xuXG4gICAgY29uc3QgcXVlcnkgPSB7XG4gICAgICBjdXJzb3I6IHRoaXMsXG4gICAgICBkaXJ0eTogZmFsc2UsXG4gICAgICBkaXN0YW5jZXMsXG4gICAgICBtYXRjaGVyOiB0aGlzLm1hdGNoZXIsIC8vIG5vdCBmYXN0IHBhdGhlZFxuICAgICAgb3JkZXJlZCxcbiAgICAgIHByb2plY3Rpb25GbjogdGhpcy5fcHJvamVjdGlvbkZuLFxuICAgICAgcmVzdWx0c1NuYXBzaG90OiBudWxsLFxuICAgICAgc29ydGVyOiBvcmRlcmVkICYmIHRoaXMuc29ydGVyXG4gICAgfTtcblxuICAgIGxldCBxaWQ7XG5cbiAgICAvLyBOb24tcmVhY3RpdmUgcXVlcmllcyBjYWxsIGFkZGVkW0JlZm9yZV0gYW5kIHRoZW4gbmV2ZXIgY2FsbCBhbnl0aGluZ1xuICAgIC8vIGVsc2UuXG4gICAgaWYgKHRoaXMucmVhY3RpdmUpIHtcbiAgICAgIHFpZCA9IHRoaXMuY29sbGVjdGlvbi5uZXh0X3FpZCsrO1xuICAgICAgdGhpcy5jb2xsZWN0aW9uLnF1ZXJpZXNbcWlkXSA9IHF1ZXJ5O1xuICAgIH1cblxuICAgIHF1ZXJ5LnJlc3VsdHMgPSB0aGlzLl9nZXRSYXdPYmplY3RzKHtvcmRlcmVkLCBkaXN0YW5jZXM6IHF1ZXJ5LmRpc3RhbmNlc30pO1xuXG4gICAgaWYgKHRoaXMuY29sbGVjdGlvbi5wYXVzZWQpIHtcbiAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCA9IG9yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIH1cblxuICAgIC8vIHdyYXAgY2FsbGJhY2tzIHdlIHdlcmUgcGFzc2VkLiBjYWxsYmFja3Mgb25seSBmaXJlIHdoZW4gbm90IHBhdXNlZCBhbmRcbiAgICAvLyBhcmUgbmV2ZXIgdW5kZWZpbmVkXG4gICAgLy8gRmlsdGVycyBvdXQgYmxhY2tsaXN0ZWQgZmllbGRzIGFjY29yZGluZyB0byBjdXJzb3IncyBwcm9qZWN0aW9uLlxuICAgIC8vIFhYWCB3cm9uZyBwbGFjZSBmb3IgdGhpcz9cblxuICAgIC8vIGZ1cnRoZXJtb3JlLCBjYWxsYmFja3MgZW5xdWV1ZSB1bnRpbCB0aGUgb3BlcmF0aW9uIHdlJ3JlIHdvcmtpbmcgb24gaXNcbiAgICAvLyBkb25lLlxuICAgIGNvbnN0IHdyYXBDYWxsYmFjayA9IGZuID0+IHtcbiAgICAgIGlmICghZm4pIHtcbiAgICAgICAgcmV0dXJuICgpID0+IHt9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAgIHJldHVybiBmdW5jdGlvbigvKiBhcmdzKi8pIHtcbiAgICAgICAgaWYgKHNlbGYuY29sbGVjdGlvbi5wYXVzZWQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBhcmdzID0gYXJndW1lbnRzO1xuXG4gICAgICAgIHNlbGYuY29sbGVjdGlvbi5fb2JzZXJ2ZVF1ZXVlLnF1ZXVlVGFzaygoKSA9PiB7XG4gICAgICAgICAgZm4uYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICB9O1xuXG4gICAgcXVlcnkuYWRkZWQgPSB3cmFwQ2FsbGJhY2sob3B0aW9ucy5hZGRlZCk7XG4gICAgcXVlcnkuY2hhbmdlZCA9IHdyYXBDYWxsYmFjayhvcHRpb25zLmNoYW5nZWQpO1xuICAgIHF1ZXJ5LnJlbW92ZWQgPSB3cmFwQ2FsbGJhY2sob3B0aW9ucy5yZW1vdmVkKTtcblxuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICBxdWVyeS5hZGRlZEJlZm9yZSA9IHdyYXBDYWxsYmFjayhvcHRpb25zLmFkZGVkQmVmb3JlKTtcbiAgICAgIHF1ZXJ5Lm1vdmVkQmVmb3JlID0gd3JhcENhbGxiYWNrKG9wdGlvbnMubW92ZWRCZWZvcmUpO1xuICAgIH1cblxuICAgIGlmICghb3B0aW9ucy5fc3VwcHJlc3NfaW5pdGlhbCAmJiAhdGhpcy5jb2xsZWN0aW9uLnBhdXNlZCkge1xuICAgICAgcXVlcnkucmVzdWx0cy5mb3JFYWNoKGRvYyA9PiB7XG4gICAgICAgIGNvbnN0IGZpZWxkcyA9IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICAgICAgZGVsZXRlIGZpZWxkcy5faWQ7XG5cbiAgICAgICAgaWYgKG9yZGVyZWQpIHtcbiAgICAgICAgICBxdWVyeS5hZGRlZEJlZm9yZShkb2MuX2lkLCB0aGlzLl9wcm9qZWN0aW9uRm4oZmllbGRzKSwgbnVsbCk7XG4gICAgICAgIH1cblxuICAgICAgICBxdWVyeS5hZGRlZChkb2MuX2lkLCB0aGlzLl9wcm9qZWN0aW9uRm4oZmllbGRzKSk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGUgPSBPYmplY3QuYXNzaWduKG5ldyBMb2NhbENvbGxlY3Rpb24uT2JzZXJ2ZUhhbmRsZSwge1xuICAgICAgY29sbGVjdGlvbjogdGhpcy5jb2xsZWN0aW9uLFxuICAgICAgc3RvcDogKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbGxlY3Rpb24ucXVlcmllc1txaWRdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5yZWFjdGl2ZSAmJiBUcmFja2VyLmFjdGl2ZSkge1xuICAgICAgLy8gWFhYIGluIG1hbnkgY2FzZXMsIHRoZSBzYW1lIG9ic2VydmUgd2lsbCBiZSByZWNyZWF0ZWQgd2hlblxuICAgICAgLy8gdGhlIGN1cnJlbnQgYXV0b3J1biBpcyByZXJ1bi4gIHdlIGNvdWxkIHNhdmUgd29yayBieVxuICAgICAgLy8gbGV0dGluZyBpdCBsaW5nZXIgYWNyb3NzIHJlcnVuIGFuZCBwb3RlbnRpYWxseSBnZXRcbiAgICAgIC8vIHJlcHVycG9zZWQgaWYgdGhlIHNhbWUgb2JzZXJ2ZSBpcyBwZXJmb3JtZWQsIHVzaW5nIGxvZ2ljXG4gICAgICAvLyBzaW1pbGFyIHRvIHRoYXQgb2YgTWV0ZW9yLnN1YnNjcmliZS5cbiAgICAgIFRyYWNrZXIub25JbnZhbGlkYXRlKCgpID0+IHtcbiAgICAgICAgaGFuZGxlLnN0b3AoKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIHJ1biB0aGUgb2JzZXJ2ZSBjYWxsYmFja3MgcmVzdWx0aW5nIGZyb20gdGhlIGluaXRpYWwgY29udGVudHNcbiAgICAvLyBiZWZvcmUgd2UgbGVhdmUgdGhlIG9ic2VydmUuXG4gICAgdGhpcy5jb2xsZWN0aW9uLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcblxuICAgIHJldHVybiBoYW5kbGU7XG4gIH1cblxuICAvLyBYWFggTWF5YmUgd2UgbmVlZCBhIHZlcnNpb24gb2Ygb2JzZXJ2ZSB0aGF0IGp1c3QgY2FsbHMgYSBjYWxsYmFjayBpZlxuICAvLyBhbnl0aGluZyBjaGFuZ2VkLlxuICBfZGVwZW5kKGNoYW5nZXJzLCBfYWxsb3dfdW5vcmRlcmVkKSB7XG4gICAgaWYgKFRyYWNrZXIuYWN0aXZlKSB7XG4gICAgICBjb25zdCBkZXBlbmRlbmN5ID0gbmV3IFRyYWNrZXIuRGVwZW5kZW5jeTtcbiAgICAgIGNvbnN0IG5vdGlmeSA9IGRlcGVuZGVuY3kuY2hhbmdlZC5iaW5kKGRlcGVuZGVuY3kpO1xuXG4gICAgICBkZXBlbmRlbmN5LmRlcGVuZCgpO1xuXG4gICAgICBjb25zdCBvcHRpb25zID0ge19hbGxvd191bm9yZGVyZWQsIF9zdXBwcmVzc19pbml0aWFsOiB0cnVlfTtcblxuICAgICAgWydhZGRlZCcsICdhZGRlZEJlZm9yZScsICdjaGFuZ2VkJywgJ21vdmVkQmVmb3JlJywgJ3JlbW92ZWQnXVxuICAgICAgICAuZm9yRWFjaChmbiA9PiB7XG4gICAgICAgICAgaWYgKGNoYW5nZXJzW2ZuXSkge1xuICAgICAgICAgICAgb3B0aW9uc1tmbl0gPSBub3RpZnk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgLy8gb2JzZXJ2ZUNoYW5nZXMgd2lsbCBzdG9wKCkgd2hlbiB0aGlzIGNvbXB1dGF0aW9uIGlzIGludmFsaWRhdGVkXG4gICAgICB0aGlzLm9ic2VydmVDaGFuZ2VzKG9wdGlvbnMpO1xuICAgIH1cbiAgfVxuXG4gIF9nZXRDb2xsZWN0aW9uTmFtZSgpIHtcbiAgICByZXR1cm4gdGhpcy5jb2xsZWN0aW9uLm5hbWU7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgY29sbGVjdGlvbiBvZiBtYXRjaGluZyBvYmplY3RzLCBidXQgZG9lc24ndCBkZWVwIGNvcHkgdGhlbS5cbiAgLy9cbiAgLy8gSWYgb3JkZXJlZCBpcyBzZXQsIHJldHVybnMgYSBzb3J0ZWQgYXJyYXksIHJlc3BlY3Rpbmcgc29ydGVyLCBza2lwLCBhbmRcbiAgLy8gbGltaXQgcHJvcGVydGllcyBvZiB0aGUgcXVlcnkgcHJvdmlkZWQgdGhhdCBvcHRpb25zLmFwcGx5U2tpcExpbWl0IGlzXG4gIC8vIG5vdCBzZXQgdG8gZmFsc2UgKCMxMjAxKS4gSWYgc29ydGVyIGlzIGZhbHNleSwgbm8gc29ydCAtLSB5b3UgZ2V0IHRoZVxuICAvLyBuYXR1cmFsIG9yZGVyLlxuICAvL1xuICAvLyBJZiBvcmRlcmVkIGlzIG5vdCBzZXQsIHJldHVybnMgYW4gb2JqZWN0IG1hcHBpbmcgZnJvbSBJRCB0byBkb2MgKHNvcnRlcixcbiAgLy8gc2tpcCBhbmQgbGltaXQgc2hvdWxkIG5vdCBiZSBzZXQpLlxuICAvL1xuICAvLyBJZiBvcmRlcmVkIGlzIHNldCBhbmQgdGhpcyBjdXJzb3IgaXMgYSAkbmVhciBnZW9xdWVyeSwgdGhlbiB0aGlzIGZ1bmN0aW9uXG4gIC8vIHdpbGwgdXNlIGFuIF9JZE1hcCB0byB0cmFjayBlYWNoIGRpc3RhbmNlIGZyb20gdGhlICRuZWFyIGFyZ3VtZW50IHBvaW50IGluXG4gIC8vIG9yZGVyIHRvIHVzZSBpdCBhcyBhIHNvcnQga2V5LiBJZiBhbiBfSWRNYXAgaXMgcGFzc2VkIGluIHRoZSAnZGlzdGFuY2VzJ1xuICAvLyBhcmd1bWVudCwgdGhpcyBmdW5jdGlvbiB3aWxsIGNsZWFyIGl0IGFuZCB1c2UgaXQgZm9yIHRoaXMgcHVycG9zZVxuICAvLyAob3RoZXJ3aXNlIGl0IHdpbGwganVzdCBjcmVhdGUgaXRzIG93biBfSWRNYXApLiBUaGUgb2JzZXJ2ZUNoYW5nZXNcbiAgLy8gaW1wbGVtZW50YXRpb24gdXNlcyB0aGlzIHRvIHJlbWVtYmVyIHRoZSBkaXN0YW5jZXMgYWZ0ZXIgdGhpcyBmdW5jdGlvblxuICAvLyByZXR1cm5zLlxuICBfZ2V0UmF3T2JqZWN0cyhvcHRpb25zID0ge30pIHtcbiAgICAvLyBCeSBkZWZhdWx0IHRoaXMgbWV0aG9kIHdpbGwgcmVzcGVjdCBza2lwIGFuZCBsaW1pdCBiZWNhdXNlIC5mZXRjaCgpLFxuICAgIC8vIC5mb3JFYWNoKCkgZXRjLi4uIGV4cGVjdCB0aGlzIGJlaGF2aW91ci4gSXQgY2FuIGJlIGZvcmNlZCB0byBpZ25vcmVcbiAgICAvLyBza2lwIGFuZCBsaW1pdCBieSBzZXR0aW5nIGFwcGx5U2tpcExpbWl0IHRvIGZhbHNlICguY291bnQoKSBkb2VzIHRoaXMsXG4gICAgLy8gZm9yIGV4YW1wbGUpXG4gICAgY29uc3QgYXBwbHlTa2lwTGltaXQgPSBvcHRpb25zLmFwcGx5U2tpcExpbWl0ICE9PSBmYWxzZTtcblxuICAgIC8vIFhYWCB1c2UgT3JkZXJlZERpY3QgaW5zdGVhZCBvZiBhcnJheSwgYW5kIG1ha2UgSWRNYXAgYW5kIE9yZGVyZWREaWN0XG4gICAgLy8gY29tcGF0aWJsZVxuICAgIGNvbnN0IHJlc3VsdHMgPSBvcHRpb25zLm9yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuXG4gICAgLy8gZmFzdCBwYXRoIGZvciBzaW5nbGUgSUQgdmFsdWVcbiAgICBpZiAodGhpcy5fc2VsZWN0b3JJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBJZiB5b3UgaGF2ZSBub24temVybyBza2lwIGFuZCBhc2sgZm9yIGEgc2luZ2xlIGlkLCB5b3UgZ2V0IG5vdGhpbmcuXG4gICAgICAvLyBUaGlzIGlzIHNvIGl0IG1hdGNoZXMgdGhlIGJlaGF2aW9yIG9mIHRoZSAne19pZDogZm9vfScgcGF0aC5cbiAgICAgIGlmIChhcHBseVNraXBMaW1pdCAmJiB0aGlzLnNraXApIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNlbGVjdGVkRG9jID0gdGhpcy5jb2xsZWN0aW9uLl9kb2NzLmdldCh0aGlzLl9zZWxlY3RvcklkKTtcblxuICAgICAgaWYgKHNlbGVjdGVkRG9jKSB7XG4gICAgICAgIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goc2VsZWN0ZWREb2MpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdHMuc2V0KHRoaXMuX3NlbGVjdG9ySWQsIHNlbGVjdGVkRG9jKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG5cbiAgICAvLyBzbG93IHBhdGggZm9yIGFyYml0cmFyeSBzZWxlY3Rvciwgc29ydCwgc2tpcCwgbGltaXRcblxuICAgIC8vIGluIHRoZSBvYnNlcnZlQ2hhbmdlcyBjYXNlLCBkaXN0YW5jZXMgaXMgYWN0dWFsbHkgcGFydCBvZiB0aGUgXCJxdWVyeVwiXG4gICAgLy8gKGllLCBsaXZlIHJlc3VsdHMgc2V0KSBvYmplY3QuICBpbiBvdGhlciBjYXNlcywgZGlzdGFuY2VzIGlzIG9ubHkgdXNlZFxuICAgIC8vIGluc2lkZSB0aGlzIGZ1bmN0aW9uLlxuICAgIGxldCBkaXN0YW5jZXM7XG4gICAgaWYgKHRoaXMubWF0Y2hlci5oYXNHZW9RdWVyeSgpICYmIG9wdGlvbnMub3JkZXJlZCkge1xuICAgICAgaWYgKG9wdGlvbnMuZGlzdGFuY2VzKSB7XG4gICAgICAgIGRpc3RhbmNlcyA9IG9wdGlvbnMuZGlzdGFuY2VzO1xuICAgICAgICBkaXN0YW5jZXMuY2xlYXIoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRpc3RhbmNlcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jb2xsZWN0aW9uLl9kb2NzLmZvckVhY2goKGRvYywgaWQpID0+IHtcbiAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gdGhpcy5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpO1xuXG4gICAgICBpZiAobWF0Y2hSZXN1bHQucmVzdWx0KSB7XG4gICAgICAgIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goZG9jKTtcblxuICAgICAgICAgIGlmIChkaXN0YW5jZXMgJiYgbWF0Y2hSZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgZGlzdGFuY2VzLnNldChpZCwgbWF0Y2hSZXN1bHQuZGlzdGFuY2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHRzLnNldChpZCwgZG9jKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBPdmVycmlkZSB0byBlbnN1cmUgYWxsIGRvY3MgYXJlIG1hdGNoZWQgaWYgaWdub3Jpbmcgc2tpcCAmIGxpbWl0XG4gICAgICBpZiAoIWFwcGx5U2tpcExpbWl0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBGYXN0IHBhdGggZm9yIGxpbWl0ZWQgdW5zb3J0ZWQgcXVlcmllcy5cbiAgICAgIC8vIFhYWCAnbGVuZ3RoJyBjaGVjayBoZXJlIHNlZW1zIHdyb25nIGZvciBvcmRlcmVkXG4gICAgICByZXR1cm4gKFxuICAgICAgICAhdGhpcy5saW1pdCB8fFxuICAgICAgICB0aGlzLnNraXAgfHxcbiAgICAgICAgdGhpcy5zb3J0ZXIgfHxcbiAgICAgICAgcmVzdWx0cy5sZW5ndGggIT09IHRoaXMubGltaXRcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBpZiAoIW9wdGlvbnMub3JkZXJlZCkge1xuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc29ydGVyKSB7XG4gICAgICByZXN1bHRzLnNvcnQodGhpcy5zb3J0ZXIuZ2V0Q29tcGFyYXRvcih7ZGlzdGFuY2VzfSkpO1xuICAgIH1cblxuICAgIC8vIFJldHVybiB0aGUgZnVsbCBzZXQgb2YgcmVzdWx0cyBpZiB0aGVyZSBpcyBubyBza2lwIG9yIGxpbWl0IG9yIGlmIHdlJ3JlXG4gICAgLy8gaWdub3JpbmcgdGhlbVxuICAgIGlmICghYXBwbHlTa2lwTGltaXQgfHwgKCF0aGlzLmxpbWl0ICYmICF0aGlzLnNraXApKSB7XG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0cy5zbGljZShcbiAgICAgIHRoaXMuc2tpcCxcbiAgICAgIHRoaXMubGltaXQgPyB0aGlzLmxpbWl0ICsgdGhpcy5za2lwIDogcmVzdWx0cy5sZW5ndGhcbiAgICApO1xuICB9XG5cbiAgX3B1Ymxpc2hDdXJzb3Ioc3Vic2NyaXB0aW9uKSB7XG4gICAgLy8gWFhYIG1pbmltb25nbyBzaG91bGQgbm90IGRlcGVuZCBvbiBtb25nby1saXZlZGF0YSFcbiAgICBpZiAoIVBhY2thZ2UubW9uZ28pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgJ0NhblxcJ3QgcHVibGlzaCBmcm9tIE1pbmltb25nbyB3aXRob3V0IHRoZSBgbW9uZ29gIHBhY2thZ2UuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuY29sbGVjdGlvbi5uYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdDYW5cXCd0IHB1Ymxpc2ggYSBjdXJzb3IgZnJvbSBhIGNvbGxlY3Rpb24gd2l0aG91dCBhIG5hbWUuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gUGFja2FnZS5tb25nby5Nb25nby5Db2xsZWN0aW9uLl9wdWJsaXNoQ3Vyc29yKFxuICAgICAgdGhpcyxcbiAgICAgIHN1YnNjcmlwdGlvbixcbiAgICAgIHRoaXMuY29sbGVjdGlvbi5uYW1lXG4gICAgKTtcbiAgfVxufVxuIiwiaW1wb3J0IEN1cnNvciBmcm9tICcuL2N1cnNvci5qcyc7XG5pbXBvcnQgT2JzZXJ2ZUhhbmRsZSBmcm9tICcuL29ic2VydmVfaGFuZGxlLmpzJztcbmltcG9ydCB7XG4gIGhhc093bixcbiAgaXNJbmRleGFibGUsXG4gIGlzTnVtZXJpY0tleSxcbiAgaXNPcGVyYXRvck9iamVjdCxcbiAgcG9wdWxhdGVEb2N1bWVudFdpdGhRdWVyeUZpZWxkcyxcbiAgcHJvamVjdGlvbkRldGFpbHMsXG59IGZyb20gJy4vY29tbW9uLmpzJztcblxuLy8gWFhYIHR5cGUgY2hlY2tpbmcgb24gc2VsZWN0b3JzIChncmFjZWZ1bCBlcnJvciBpZiBtYWxmb3JtZWQpXG5cbi8vIExvY2FsQ29sbGVjdGlvbjogYSBzZXQgb2YgZG9jdW1lbnRzIHRoYXQgc3VwcG9ydHMgcXVlcmllcyBhbmQgbW9kaWZpZXJzLlxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgTG9jYWxDb2xsZWN0aW9uIHtcbiAgY29uc3RydWN0b3IobmFtZSkge1xuICAgIHRoaXMubmFtZSA9IG5hbWU7XG4gICAgLy8gX2lkIC0+IGRvY3VtZW50IChhbHNvIGNvbnRhaW5pbmcgaWQpXG4gICAgdGhpcy5fZG9jcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlID0gbmV3IE1ldGVvci5fU3luY2hyb25vdXNRdWV1ZSgpO1xuXG4gICAgdGhpcy5uZXh0X3FpZCA9IDE7IC8vIGxpdmUgcXVlcnkgaWQgZ2VuZXJhdG9yXG5cbiAgICAvLyBxaWQgLT4gbGl2ZSBxdWVyeSBvYmplY3QuIGtleXM6XG4gICAgLy8gIG9yZGVyZWQ6IGJvb2wuIG9yZGVyZWQgcXVlcmllcyBoYXZlIGFkZGVkQmVmb3JlL21vdmVkQmVmb3JlIGNhbGxiYWNrcy5cbiAgICAvLyAgcmVzdWx0czogYXJyYXkgKG9yZGVyZWQpIG9yIG9iamVjdCAodW5vcmRlcmVkKSBvZiBjdXJyZW50IHJlc3VsdHNcbiAgICAvLyAgICAoYWxpYXNlZCB3aXRoIHRoaXMuX2RvY3MhKVxuICAgIC8vICByZXN1bHRzU25hcHNob3Q6IHNuYXBzaG90IG9mIHJlc3VsdHMuIG51bGwgaWYgbm90IHBhdXNlZC5cbiAgICAvLyAgY3Vyc29yOiBDdXJzb3Igb2JqZWN0IGZvciB0aGUgcXVlcnkuXG4gICAgLy8gIHNlbGVjdG9yLCBzb3J0ZXIsIChjYWxsYmFja3MpOiBmdW5jdGlvbnNcbiAgICB0aGlzLnF1ZXJpZXMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuXG4gICAgLy8gbnVsbCBpZiBub3Qgc2F2aW5nIG9yaWdpbmFsczsgYW4gSWRNYXAgZnJvbSBpZCB0byBvcmlnaW5hbCBkb2N1bWVudCB2YWx1ZVxuICAgIC8vIGlmIHNhdmluZyBvcmlnaW5hbHMuIFNlZSBjb21tZW50cyBiZWZvcmUgc2F2ZU9yaWdpbmFscygpLlxuICAgIHRoaXMuX3NhdmVkT3JpZ2luYWxzID0gbnVsbDtcblxuICAgIC8vIFRydWUgd2hlbiBvYnNlcnZlcnMgYXJlIHBhdXNlZCBhbmQgd2Ugc2hvdWxkIG5vdCBzZW5kIGNhbGxiYWNrcy5cbiAgICB0aGlzLnBhdXNlZCA9IGZhbHNlO1xuICB9XG5cbiAgLy8gb3B0aW9ucyBtYXkgaW5jbHVkZSBzb3J0LCBza2lwLCBsaW1pdCwgcmVhY3RpdmVcbiAgLy8gc29ydCBtYXkgYmUgYW55IG9mIHRoZXNlIGZvcm1zOlxuICAvLyAgICAge2E6IDEsIGI6IC0xfVxuICAvLyAgICAgW1tcImFcIiwgXCJhc2NcIl0sIFtcImJcIiwgXCJkZXNjXCJdXVxuICAvLyAgICAgW1wiYVwiLCBbXCJiXCIsIFwiZGVzY1wiXV1cbiAgLy8gICAoaW4gdGhlIGZpcnN0IGZvcm0geW91J3JlIGJlaG9sZGVuIHRvIGtleSBlbnVtZXJhdGlvbiBvcmRlciBpblxuICAvLyAgIHlvdXIgamF2YXNjcmlwdCBWTSlcbiAgLy9cbiAgLy8gcmVhY3RpdmU6IGlmIGdpdmVuLCBhbmQgZmFsc2UsIGRvbid0IHJlZ2lzdGVyIHdpdGggVHJhY2tlciAoZGVmYXVsdFxuICAvLyBpcyB0cnVlKVxuICAvL1xuICAvLyBYWFggcG9zc2libHkgc2hvdWxkIHN1cHBvcnQgcmV0cmlldmluZyBhIHN1YnNldCBvZiBmaWVsZHM/IGFuZFxuICAvLyBoYXZlIGl0IGJlIGEgaGludCAoaWdub3JlZCBvbiB0aGUgY2xpZW50LCB3aGVuIG5vdCBjb3B5aW5nIHRoZVxuICAvLyBkb2M/KVxuICAvL1xuICAvLyBYWFggc29ydCBkb2VzIG5vdCB5ZXQgc3VwcG9ydCBzdWJrZXlzICgnYS5iJykgLi4gZml4IHRoYXQhXG4gIC8vIFhYWCBhZGQgb25lIG1vcmUgc29ydCBmb3JtOiBcImtleVwiXG4gIC8vIFhYWCB0ZXN0c1xuICBmaW5kKHNlbGVjdG9yLCBvcHRpb25zKSB7XG4gICAgLy8gZGVmYXVsdCBzeW50YXggZm9yIGV2ZXJ5dGhpbmcgaXMgdG8gb21pdCB0aGUgc2VsZWN0b3IgYXJndW1lbnQuXG4gICAgLy8gYnV0IGlmIHNlbGVjdG9yIGlzIGV4cGxpY2l0bHkgcGFzc2VkIGluIGFzIGZhbHNlIG9yIHVuZGVmaW5lZCwgd2VcbiAgICAvLyB3YW50IGEgc2VsZWN0b3IgdGhhdCBtYXRjaGVzIG5vdGhpbmcuXG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgIHNlbGVjdG9yID0ge307XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBMb2NhbENvbGxlY3Rpb24uQ3Vyc29yKHRoaXMsIHNlbGVjdG9yLCBvcHRpb25zKTtcbiAgfVxuXG4gIGZpbmRPbmUoc2VsZWN0b3IsIG9wdGlvbnMgPSB7fSkge1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBzZWxlY3RvciA9IHt9O1xuICAgIH1cblxuICAgIC8vIE5PVEU6IGJ5IHNldHRpbmcgbGltaXQgMSBoZXJlLCB3ZSBlbmQgdXAgdXNpbmcgdmVyeSBpbmVmZmljaWVudFxuICAgIC8vIGNvZGUgdGhhdCByZWNvbXB1dGVzIHRoZSB3aG9sZSBxdWVyeSBvbiBlYWNoIHVwZGF0ZS4gVGhlIHVwc2lkZSBpc1xuICAgIC8vIHRoYXQgd2hlbiB5b3UgcmVhY3RpdmVseSBkZXBlbmQgb24gYSBmaW5kT25lIHlvdSBvbmx5IGdldFxuICAgIC8vIGludmFsaWRhdGVkIHdoZW4gdGhlIGZvdW5kIG9iamVjdCBjaGFuZ2VzLCBub3QgYW55IG9iamVjdCBpbiB0aGVcbiAgICAvLyBjb2xsZWN0aW9uLiBNb3N0IGZpbmRPbmUgd2lsbCBiZSBieSBpZCwgd2hpY2ggaGFzIGEgZmFzdCBwYXRoLCBzb1xuICAgIC8vIHRoaXMgbWlnaHQgbm90IGJlIGEgYmlnIGRlYWwuIEluIG1vc3QgY2FzZXMsIGludmFsaWRhdGlvbiBjYXVzZXNcbiAgICAvLyB0aGUgY2FsbGVkIHRvIHJlLXF1ZXJ5IGFueXdheSwgc28gdGhpcyBzaG91bGQgYmUgYSBuZXQgcGVyZm9ybWFuY2VcbiAgICAvLyBpbXByb3ZlbWVudC5cbiAgICBvcHRpb25zLmxpbWl0ID0gMTtcblxuICAgIHJldHVybiB0aGlzLmZpbmQoc2VsZWN0b3IsIG9wdGlvbnMpLmZldGNoKClbMF07XG4gIH1cblxuICAvLyBYWFggcG9zc2libHkgZW5mb3JjZSB0aGF0ICd1bmRlZmluZWQnIGRvZXMgbm90IGFwcGVhciAod2UgYXNzdW1lXG4gIC8vIHRoaXMgaW4gb3VyIGhhbmRsaW5nIG9mIG51bGwgYW5kICRleGlzdHMpXG4gIGluc2VydChkb2MsIGNhbGxiYWNrKSB7XG4gICAgZG9jID0gRUpTT04uY2xvbmUoZG9jKTtcblxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyhkb2MpO1xuXG4gICAgLy8gaWYgeW91IHJlYWxseSB3YW50IHRvIHVzZSBPYmplY3RJRHMsIHNldCB0aGlzIGdsb2JhbC5cbiAgICAvLyBNb25nby5Db2xsZWN0aW9uIHNwZWNpZmllcyBpdHMgb3duIGlkcyBhbmQgZG9lcyBub3QgdXNlIHRoaXMgY29kZS5cbiAgICBpZiAoIWhhc093bi5jYWxsKGRvYywgJ19pZCcpKSB7XG4gICAgICBkb2MuX2lkID0gTG9jYWxDb2xsZWN0aW9uLl91c2VPSUQgPyBuZXcgTW9uZ29JRC5PYmplY3RJRCgpIDogUmFuZG9tLmlkKCk7XG4gICAgfVxuXG4gICAgY29uc3QgaWQgPSBkb2MuX2lkO1xuXG4gICAgaWYgKHRoaXMuX2RvY3MuaGFzKGlkKSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoYER1cGxpY2F0ZSBfaWQgJyR7aWR9J2ApO1xuICAgIH1cblxuICAgIHRoaXMuX3NhdmVPcmlnaW5hbChpZCwgdW5kZWZpbmVkKTtcbiAgICB0aGlzLl9kb2NzLnNldChpZCwgZG9jKTtcblxuICAgIGNvbnN0IHF1ZXJpZXNUb1JlY29tcHV0ZSA9IFtdO1xuXG4gICAgLy8gdHJpZ2dlciBsaXZlIHF1ZXJpZXMgdGhhdCBtYXRjaFxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWF0Y2hSZXN1bHQgPSBxdWVyeS5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpO1xuXG4gICAgICBpZiAobWF0Y2hSZXN1bHQucmVzdWx0KSB7XG4gICAgICAgIGlmIChxdWVyeS5kaXN0YW5jZXMgJiYgbWF0Y2hSZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHF1ZXJ5LmRpc3RhbmNlcy5zZXQoaWQsIG1hdGNoUmVzdWx0LmRpc3RhbmNlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChxdWVyeS5jdXJzb3Iuc2tpcCB8fCBxdWVyeS5jdXJzb3IubGltaXQpIHtcbiAgICAgICAgICBxdWVyaWVzVG9SZWNvbXB1dGUucHVzaChxaWQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIExvY2FsQ29sbGVjdGlvbi5faW5zZXJ0SW5SZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBxdWVyaWVzVG9SZWNvbXB1dGUuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgaWYgKHRoaXMucXVlcmllc1txaWRdKSB7XG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHModGhpcy5xdWVyaWVzW3FpZF0pO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlLmRyYWluKCk7XG5cbiAgICAvLyBEZWZlciBiZWNhdXNlIHRoZSBjYWxsZXIgbGlrZWx5IGRvZXNuJ3QgZXhwZWN0IHRoZSBjYWxsYmFjayB0byBiZSBydW5cbiAgICAvLyBpbW1lZGlhdGVseS5cbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIE1ldGVvci5kZWZlcigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIGlkKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBpZDtcbiAgfVxuXG4gIC8vIFBhdXNlIHRoZSBvYnNlcnZlcnMuIE5vIGNhbGxiYWNrcyBmcm9tIG9ic2VydmVycyB3aWxsIGZpcmUgdW50aWxcbiAgLy8gJ3Jlc3VtZU9ic2VydmVycycgaXMgY2FsbGVkLlxuICBwYXVzZU9ic2VydmVycygpIHtcbiAgICAvLyBOby1vcCBpZiBhbHJlYWR5IHBhdXNlZC5cbiAgICBpZiAodGhpcy5wYXVzZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBTZXQgdGhlICdwYXVzZWQnIGZsYWcgc3VjaCB0aGF0IG5ldyBvYnNlcnZlciBtZXNzYWdlcyBkb24ndCBmaXJlLlxuICAgIHRoaXMucGF1c2VkID0gdHJ1ZTtcblxuICAgIC8vIFRha2UgYSBzbmFwc2hvdCBvZiB0aGUgcXVlcnkgcmVzdWx0cyBmb3IgZWFjaCBxdWVyeS5cbiAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG4gICAgICBxdWVyeS5yZXN1bHRzU25hcHNob3QgPSBFSlNPTi5jbG9uZShxdWVyeS5yZXN1bHRzKTtcbiAgICB9KTtcbiAgfVxuXG4gIHJlbW92ZShzZWxlY3RvciwgY2FsbGJhY2spIHtcbiAgICAvLyBFYXN5IHNwZWNpYWwgY2FzZTogaWYgd2UncmUgbm90IGNhbGxpbmcgb2JzZXJ2ZUNoYW5nZXMgY2FsbGJhY2tzIGFuZFxuICAgIC8vIHdlJ3JlIG5vdCBzYXZpbmcgb3JpZ2luYWxzIGFuZCB3ZSBnb3QgYXNrZWQgdG8gcmVtb3ZlIGV2ZXJ5dGhpbmcsIHRoZW5cbiAgICAvLyBqdXN0IGVtcHR5IGV2ZXJ5dGhpbmcgZGlyZWN0bHkuXG4gICAgaWYgKHRoaXMucGF1c2VkICYmICF0aGlzLl9zYXZlZE9yaWdpbmFscyAmJiBFSlNPTi5lcXVhbHMoc2VsZWN0b3IsIHt9KSkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy5fZG9jcy5zaXplKCk7XG5cbiAgICAgIHRoaXMuX2RvY3MuY2xlYXIoKTtcblxuICAgICAgT2JqZWN0LmtleXModGhpcy5xdWVyaWVzKS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG5cbiAgICAgICAgaWYgKHF1ZXJ5Lm9yZGVyZWQpIHtcbiAgICAgICAgICBxdWVyeS5yZXN1bHRzID0gW107XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcXVlcnkucmVzdWx0cy5jbGVhcigpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICAgIE1ldGVvci5kZWZlcigoKSA9PiB7XG4gICAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3Rvcik7XG4gICAgY29uc3QgcmVtb3ZlID0gW107XG5cbiAgICB0aGlzLl9lYWNoUG9zc2libHlNYXRjaGluZ0RvYyhzZWxlY3RvciwgKGRvYywgaWQpID0+IHtcbiAgICAgIGlmIChtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpLnJlc3VsdCkge1xuICAgICAgICByZW1vdmUucHVzaChpZCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjb25zdCBxdWVyaWVzVG9SZWNvbXB1dGUgPSBbXTtcbiAgICBjb25zdCBxdWVyeVJlbW92ZSA9IFtdO1xuXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCByZW1vdmUubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IHJlbW92ZUlkID0gcmVtb3ZlW2ldO1xuICAgICAgY29uc3QgcmVtb3ZlRG9jID0gdGhpcy5fZG9jcy5nZXQocmVtb3ZlSWQpO1xuXG4gICAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgICBpZiAocXVlcnkuZGlydHkpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocXVlcnkubWF0Y2hlci5kb2N1bWVudE1hdGNoZXMocmVtb3ZlRG9jKS5yZXN1bHQpIHtcbiAgICAgICAgICBpZiAocXVlcnkuY3Vyc29yLnNraXAgfHwgcXVlcnkuY3Vyc29yLmxpbWl0KSB7XG4gICAgICAgICAgICBxdWVyaWVzVG9SZWNvbXB1dGUucHVzaChxaWQpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBxdWVyeVJlbW92ZS5wdXNoKHtxaWQsIGRvYzogcmVtb3ZlRG9jfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5fc2F2ZU9yaWdpbmFsKHJlbW92ZUlkLCByZW1vdmVEb2MpO1xuICAgICAgdGhpcy5fZG9jcy5yZW1vdmUocmVtb3ZlSWQpO1xuICAgIH1cblxuICAgIC8vIHJ1biBsaXZlIHF1ZXJ5IGNhbGxiYWNrcyBfYWZ0ZXJfIHdlJ3ZlIHJlbW92ZWQgdGhlIGRvY3VtZW50cy5cbiAgICBxdWVyeVJlbW92ZS5mb3JFYWNoKHJlbW92ZSA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1tyZW1vdmUucWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgIHF1ZXJ5LmRpc3RhbmNlcyAmJiBxdWVyeS5kaXN0YW5jZXMucmVtb3ZlKHJlbW92ZS5kb2MuX2lkKTtcbiAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9yZW1vdmVGcm9tUmVzdWx0cyhxdWVyeSwgcmVtb3ZlLmRvYyk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBxdWVyaWVzVG9SZWNvbXB1dGUuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHMocXVlcnkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlLmRyYWluKCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZW1vdmUubGVuZ3RoO1xuXG4gICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICBNZXRlb3IuZGVmZXIoKCkgPT4ge1xuICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIFJlc3VtZSB0aGUgb2JzZXJ2ZXJzLiBPYnNlcnZlcnMgaW1tZWRpYXRlbHkgcmVjZWl2ZSBjaGFuZ2VcbiAgLy8gbm90aWZpY2F0aW9ucyB0byBicmluZyB0aGVtIHRvIHRoZSBjdXJyZW50IHN0YXRlIG9mIHRoZVxuICAvLyBkYXRhYmFzZS4gTm90ZSB0aGF0IHRoaXMgaXMgbm90IGp1c3QgcmVwbGF5aW5nIGFsbCB0aGUgY2hhbmdlcyB0aGF0XG4gIC8vIGhhcHBlbmVkIGR1cmluZyB0aGUgcGF1c2UsIGl0IGlzIGEgc21hcnRlciAnY29hbGVzY2VkJyBkaWZmLlxuICByZXN1bWVPYnNlcnZlcnMoKSB7XG4gICAgLy8gTm8tb3AgaWYgbm90IHBhdXNlZC5cbiAgICBpZiAoIXRoaXMucGF1c2VkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gVW5zZXQgdGhlICdwYXVzZWQnIGZsYWcuIE1ha2Ugc3VyZSB0byBkbyB0aGlzIGZpcnN0LCBvdGhlcndpc2VcbiAgICAvLyBvYnNlcnZlciBtZXRob2RzIHdvbid0IGFjdHVhbGx5IGZpcmUgd2hlbiB3ZSB0cmlnZ2VyIHRoZW0uXG4gICAgdGhpcy5wYXVzZWQgPSBmYWxzZTtcblxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHF1ZXJ5LmRpcnR5ID0gZmFsc2U7XG5cbiAgICAgICAgLy8gcmUtY29tcHV0ZSByZXN1bHRzIHdpbGwgcGVyZm9ybSBgTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlDaGFuZ2VzYFxuICAgICAgICAvLyBhdXRvbWF0aWNhbGx5LlxuICAgICAgICB0aGlzLl9yZWNvbXB1dGVSZXN1bHRzKHF1ZXJ5LCBxdWVyeS5yZXN1bHRzU25hcHNob3QpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gRGlmZiB0aGUgY3VycmVudCByZXN1bHRzIGFnYWluc3QgdGhlIHNuYXBzaG90IGFuZCBzZW5kIHRvIG9ic2VydmVycy5cbiAgICAgICAgLy8gcGFzcyB0aGUgcXVlcnkgb2JqZWN0IGZvciBpdHMgb2JzZXJ2ZXIgY2FsbGJhY2tzLlxuICAgICAgICBMb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeUNoYW5nZXMoXG4gICAgICAgICAgcXVlcnkub3JkZXJlZCxcbiAgICAgICAgICBxdWVyeS5yZXN1bHRzU25hcHNob3QsXG4gICAgICAgICAgcXVlcnkucmVzdWx0cyxcbiAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICB7cHJvamVjdGlvbkZuOiBxdWVyeS5wcm9qZWN0aW9uRm59XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCA9IG51bGw7XG4gICAgfSk7XG5cbiAgICB0aGlzLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcbiAgfVxuXG4gIHJldHJpZXZlT3JpZ2luYWxzKCkge1xuICAgIGlmICghdGhpcy5fc2F2ZWRPcmlnaW5hbHMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2FsbGVkIHJldHJpZXZlT3JpZ2luYWxzIHdpdGhvdXQgc2F2ZU9yaWdpbmFscycpO1xuICAgIH1cblxuICAgIGNvbnN0IG9yaWdpbmFscyA9IHRoaXMuX3NhdmVkT3JpZ2luYWxzO1xuXG4gICAgdGhpcy5fc2F2ZWRPcmlnaW5hbHMgPSBudWxsO1xuXG4gICAgcmV0dXJuIG9yaWdpbmFscztcbiAgfVxuXG4gIC8vIFRvIHRyYWNrIHdoYXQgZG9jdW1lbnRzIGFyZSBhZmZlY3RlZCBieSBhIHBpZWNlIG9mIGNvZGUsIGNhbGxcbiAgLy8gc2F2ZU9yaWdpbmFscygpIGJlZm9yZSBpdCBhbmQgcmV0cmlldmVPcmlnaW5hbHMoKSBhZnRlciBpdC5cbiAgLy8gcmV0cmlldmVPcmlnaW5hbHMgcmV0dXJucyBhbiBvYmplY3Qgd2hvc2Uga2V5cyBhcmUgdGhlIGlkcyBvZiB0aGUgZG9jdW1lbnRzXG4gIC8vIHRoYXQgd2VyZSBhZmZlY3RlZCBzaW5jZSB0aGUgY2FsbCB0byBzYXZlT3JpZ2luYWxzKCksIGFuZCB0aGUgdmFsdWVzIGFyZVxuICAvLyBlcXVhbCB0byB0aGUgZG9jdW1lbnQncyBjb250ZW50cyBhdCB0aGUgdGltZSBvZiBzYXZlT3JpZ2luYWxzLiAoSW4gdGhlIGNhc2VcbiAgLy8gb2YgYW4gaW5zZXJ0ZWQgZG9jdW1lbnQsIHVuZGVmaW5lZCBpcyB0aGUgdmFsdWUuKSBZb3UgbXVzdCBhbHRlcm5hdGVcbiAgLy8gYmV0d2VlbiBjYWxscyB0byBzYXZlT3JpZ2luYWxzKCkgYW5kIHJldHJpZXZlT3JpZ2luYWxzKCkuXG4gIHNhdmVPcmlnaW5hbHMoKSB7XG4gICAgaWYgKHRoaXMuX3NhdmVkT3JpZ2luYWxzKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0NhbGxlZCBzYXZlT3JpZ2luYWxzIHR3aWNlIHdpdGhvdXQgcmV0cmlldmVPcmlnaW5hbHMnKTtcbiAgICB9XG5cbiAgICB0aGlzLl9zYXZlZE9yaWdpbmFscyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICB9XG5cbiAgLy8gWFhYIGF0b21pY2l0eTogaWYgbXVsdGkgaXMgdHJ1ZSwgYW5kIG9uZSBtb2RpZmljYXRpb24gZmFpbHMsIGRvXG4gIC8vIHdlIHJvbGxiYWNrIHRoZSB3aG9sZSBvcGVyYXRpb24sIG9yIHdoYXQ/XG4gIHVwZGF0ZShzZWxlY3RvciwgbW9kLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICAgIGlmICghIGNhbGxiYWNrICYmIG9wdGlvbnMgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IG51bGw7XG4gICAgfVxuXG4gICAgaWYgKCFvcHRpb25zKSB7XG4gICAgICBvcHRpb25zID0ge307XG4gICAgfVxuXG4gICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3RvciwgdHJ1ZSk7XG5cbiAgICAvLyBTYXZlIHRoZSBvcmlnaW5hbCByZXN1bHRzIG9mIGFueSBxdWVyeSB0aGF0IHdlIG1pZ2h0IG5lZWQgdG9cbiAgICAvLyBfcmVjb21wdXRlUmVzdWx0cyBvbiwgYmVjYXVzZSBfbW9kaWZ5QW5kTm90aWZ5IHdpbGwgbXV0YXRlIHRoZSBvYmplY3RzIGluXG4gICAgLy8gaXQuIChXZSBkb24ndCBuZWVkIHRvIHNhdmUgdGhlIG9yaWdpbmFsIHJlc3VsdHMgb2YgcGF1c2VkIHF1ZXJpZXMgYmVjYXVzZVxuICAgIC8vIHRoZXkgYWxyZWFkeSBoYXZlIGEgcmVzdWx0c1NuYXBzaG90IGFuZCB3ZSB3b24ndCBiZSBkaWZmaW5nIGluXG4gICAgLy8gX3JlY29tcHV0ZVJlc3VsdHMuKVxuICAgIGNvbnN0IHFpZFRvT3JpZ2luYWxSZXN1bHRzID0ge307XG5cbiAgICAvLyBXZSBzaG91bGQgb25seSBjbG9uZSBlYWNoIGRvY3VtZW50IG9uY2UsIGV2ZW4gaWYgaXQgYXBwZWFycyBpbiBtdWx0aXBsZVxuICAgIC8vIHF1ZXJpZXNcbiAgICBjb25zdCBkb2NNYXAgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICBjb25zdCBpZHNNYXRjaGVkID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihzZWxlY3Rvcik7XG5cbiAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG5cbiAgICAgIGlmICgocXVlcnkuY3Vyc29yLnNraXAgfHwgcXVlcnkuY3Vyc29yLmxpbWl0KSAmJiAhIHRoaXMucGF1c2VkKSB7XG4gICAgICAgIC8vIENhdGNoIHRoZSBjYXNlIG9mIGEgcmVhY3RpdmUgYGNvdW50KClgIG9uIGEgY3Vyc29yIHdpdGggc2tpcFxuICAgICAgICAvLyBvciBsaW1pdCwgd2hpY2ggcmVnaXN0ZXJzIGFuIHVub3JkZXJlZCBvYnNlcnZlLiBUaGlzIGlzIGFcbiAgICAgICAgLy8gcHJldHR5IHJhcmUgY2FzZSwgc28gd2UganVzdCBjbG9uZSB0aGUgZW50aXJlIHJlc3VsdCBzZXQgd2l0aFxuICAgICAgICAvLyBubyBvcHRpbWl6YXRpb25zIGZvciBkb2N1bWVudHMgdGhhdCBhcHBlYXIgaW4gdGhlc2UgcmVzdWx0XG4gICAgICAgIC8vIHNldHMgYW5kIG90aGVyIHF1ZXJpZXMuXG4gICAgICAgIGlmIChxdWVyeS5yZXN1bHRzIGluc3RhbmNlb2YgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcCkge1xuICAgICAgICAgIHFpZFRvT3JpZ2luYWxSZXN1bHRzW3FpZF0gPSBxdWVyeS5yZXN1bHRzLmNsb25lKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCEocXVlcnkucmVzdWx0cyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQXNzZXJ0aW9uIGZhaWxlZDogcXVlcnkucmVzdWx0cyBub3QgYW4gYXJyYXknKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENsb25lcyBhIGRvY3VtZW50IHRvIGJlIHN0b3JlZCBpbiBgcWlkVG9PcmlnaW5hbFJlc3VsdHNgXG4gICAgICAgIC8vIGJlY2F1c2UgaXQgbWF5IGJlIG1vZGlmaWVkIGJlZm9yZSB0aGUgbmV3IGFuZCBvbGQgcmVzdWx0IHNldHNcbiAgICAgICAgLy8gYXJlIGRpZmZlZC4gQnV0IGlmIHdlIGtub3cgZXhhY3RseSB3aGljaCBkb2N1bWVudCBJRHMgd2UncmVcbiAgICAgICAgLy8gZ29pbmcgdG8gbW9kaWZ5LCB0aGVuIHdlIG9ubHkgbmVlZCB0byBjbG9uZSB0aG9zZS5cbiAgICAgICAgY29uc3QgbWVtb2l6ZWRDbG9uZUlmTmVlZGVkID0gZG9jID0+IHtcbiAgICAgICAgICBpZiAoZG9jTWFwLmhhcyhkb2MuX2lkKSkge1xuICAgICAgICAgICAgcmV0dXJuIGRvY01hcC5nZXQoZG9jLl9pZCk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgZG9jVG9NZW1vaXplID0gKFxuICAgICAgICAgICAgaWRzTWF0Y2hlZCAmJlxuICAgICAgICAgICAgIWlkc01hdGNoZWQuc29tZShpZCA9PiBFSlNPTi5lcXVhbHMoaWQsIGRvYy5faWQpKVxuICAgICAgICAgICkgPyBkb2MgOiBFSlNPTi5jbG9uZShkb2MpO1xuXG4gICAgICAgICAgZG9jTWFwLnNldChkb2MuX2lkLCBkb2NUb01lbW9pemUpO1xuXG4gICAgICAgICAgcmV0dXJuIGRvY1RvTWVtb2l6ZTtcbiAgICAgICAgfTtcblxuICAgICAgICBxaWRUb09yaWdpbmFsUmVzdWx0c1txaWRdID0gcXVlcnkucmVzdWx0cy5tYXAobWVtb2l6ZWRDbG9uZUlmTmVlZGVkKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IHJlY29tcHV0ZVFpZHMgPSB7fTtcblxuICAgIGxldCB1cGRhdGVDb3VudCA9IDA7XG5cbiAgICB0aGlzLl9lYWNoUG9zc2libHlNYXRjaGluZ0RvYyhzZWxlY3RvciwgKGRvYywgaWQpID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5UmVzdWx0ID0gbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoZG9jKTtcblxuICAgICAgaWYgKHF1ZXJ5UmVzdWx0LnJlc3VsdCkge1xuICAgICAgICAvLyBYWFggU2hvdWxkIHdlIHNhdmUgdGhlIG9yaWdpbmFsIGV2ZW4gaWYgbW9kIGVuZHMgdXAgYmVpbmcgYSBuby1vcD9cbiAgICAgICAgdGhpcy5fc2F2ZU9yaWdpbmFsKGlkLCBkb2MpO1xuICAgICAgICB0aGlzLl9tb2RpZnlBbmROb3RpZnkoXG4gICAgICAgICAgZG9jLFxuICAgICAgICAgIG1vZCxcbiAgICAgICAgICByZWNvbXB1dGVRaWRzLFxuICAgICAgICAgIHF1ZXJ5UmVzdWx0LmFycmF5SW5kaWNlc1xuICAgICAgICApO1xuXG4gICAgICAgICsrdXBkYXRlQ291bnQ7XG5cbiAgICAgICAgaWYgKCFvcHRpb25zLm11bHRpKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlOyAvLyBicmVha1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuXG4gICAgT2JqZWN0LmtleXMocmVjb21wdXRlUWlkcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHMocXVlcnksIHFpZFRvT3JpZ2luYWxSZXN1bHRzW3FpZF0pO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgdGhpcy5fb2JzZXJ2ZVF1ZXVlLmRyYWluKCk7XG5cbiAgICAvLyBJZiB3ZSBhcmUgZG9pbmcgYW4gdXBzZXJ0LCBhbmQgd2UgZGlkbid0IG1vZGlmeSBhbnkgZG9jdW1lbnRzIHlldCwgdGhlblxuICAgIC8vIGl0J3MgdGltZSB0byBkbyBhbiBpbnNlcnQuIEZpZ3VyZSBvdXQgd2hhdCBkb2N1bWVudCB3ZSBhcmUgaW5zZXJ0aW5nLCBhbmRcbiAgICAvLyBnZW5lcmF0ZSBhbiBpZCBmb3IgaXQuXG4gICAgbGV0IGluc2VydGVkSWQ7XG4gICAgaWYgKHVwZGF0ZUNvdW50ID09PSAwICYmIG9wdGlvbnMudXBzZXJ0KSB7XG4gICAgICBjb25zdCBkb2MgPSBMb2NhbENvbGxlY3Rpb24uX2NyZWF0ZVVwc2VydERvY3VtZW50KHNlbGVjdG9yLCBtb2QpO1xuICAgICAgaWYgKCEgZG9jLl9pZCAmJiBvcHRpb25zLmluc2VydGVkSWQpIHtcbiAgICAgICAgZG9jLl9pZCA9IG9wdGlvbnMuaW5zZXJ0ZWRJZDtcbiAgICAgIH1cblxuICAgICAgaW5zZXJ0ZWRJZCA9IHRoaXMuaW5zZXJ0KGRvYyk7XG4gICAgICB1cGRhdGVDb3VudCA9IDE7XG4gICAgfVxuXG4gICAgLy8gUmV0dXJuIHRoZSBudW1iZXIgb2YgYWZmZWN0ZWQgZG9jdW1lbnRzLCBvciBpbiB0aGUgdXBzZXJ0IGNhc2UsIGFuIG9iamVjdFxuICAgIC8vIGNvbnRhaW5pbmcgdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2NzIGFuZCB0aGUgaWQgb2YgdGhlIGRvYyB0aGF0IHdhc1xuICAgIC8vIGluc2VydGVkLCBpZiBhbnkuXG4gICAgbGV0IHJlc3VsdDtcbiAgICBpZiAob3B0aW9ucy5fcmV0dXJuT2JqZWN0KSB7XG4gICAgICByZXN1bHQgPSB7bnVtYmVyQWZmZWN0ZWQ6IHVwZGF0ZUNvdW50fTtcblxuICAgICAgaWYgKGluc2VydGVkSWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXN1bHQuaW5zZXJ0ZWRJZCA9IGluc2VydGVkSWQ7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdCA9IHVwZGF0ZUNvdW50O1xuICAgIH1cblxuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgTWV0ZW9yLmRlZmVyKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvLyBBIGNvbnZlbmllbmNlIHdyYXBwZXIgb24gdXBkYXRlLiBMb2NhbENvbGxlY3Rpb24udXBzZXJ0KHNlbCwgbW9kKSBpc1xuICAvLyBlcXVpdmFsZW50IHRvIExvY2FsQ29sbGVjdGlvbi51cGRhdGUoc2VsLCBtb2QsIHt1cHNlcnQ6IHRydWUsXG4gIC8vIF9yZXR1cm5PYmplY3Q6IHRydWV9KS5cbiAgdXBzZXJ0KHNlbGVjdG9yLCBtb2QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKCFjYWxsYmFjayAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgICAgb3B0aW9ucyA9IHt9O1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLnVwZGF0ZShcbiAgICAgIHNlbGVjdG9yLFxuICAgICAgbW9kLFxuICAgICAgT2JqZWN0LmFzc2lnbih7fSwgb3B0aW9ucywge3Vwc2VydDogdHJ1ZSwgX3JldHVybk9iamVjdDogdHJ1ZX0pLFxuICAgICAgY2FsbGJhY2tcbiAgICApO1xuICB9XG5cbiAgLy8gSXRlcmF0ZXMgb3ZlciBhIHN1YnNldCBvZiBkb2N1bWVudHMgdGhhdCBjb3VsZCBtYXRjaCBzZWxlY3RvcjsgY2FsbHNcbiAgLy8gZm4oZG9jLCBpZCkgb24gZWFjaCBvZiB0aGVtLiAgU3BlY2lmaWNhbGx5LCBpZiBzZWxlY3RvciBzcGVjaWZpZXNcbiAgLy8gc3BlY2lmaWMgX2lkJ3MsIGl0IG9ubHkgbG9va3MgYXQgdGhvc2UuICBkb2MgaXMgKm5vdCogY2xvbmVkOiBpdCBpcyB0aGVcbiAgLy8gc2FtZSBvYmplY3QgdGhhdCBpcyBpbiBfZG9jcy5cbiAgX2VhY2hQb3NzaWJseU1hdGNoaW5nRG9jKHNlbGVjdG9yLCBmbikge1xuICAgIGNvbnN0IHNwZWNpZmljSWRzID0gTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvcihzZWxlY3Rvcik7XG5cbiAgICBpZiAoc3BlY2lmaWNJZHMpIHtcbiAgICAgIHNwZWNpZmljSWRzLnNvbWUoaWQgPT4ge1xuICAgICAgICBjb25zdCBkb2MgPSB0aGlzLl9kb2NzLmdldChpZCk7XG5cbiAgICAgICAgaWYgKGRvYykge1xuICAgICAgICAgIHJldHVybiBmbihkb2MsIGlkKSA9PT0gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9kb2NzLmZvckVhY2goZm4pO1xuICAgIH1cbiAgfVxuXG4gIF9tb2RpZnlBbmROb3RpZnkoZG9jLCBtb2QsIHJlY29tcHV0ZVFpZHMsIGFycmF5SW5kaWNlcykge1xuICAgIGNvbnN0IG1hdGNoZWRfYmVmb3JlID0ge307XG5cbiAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3FpZF07XG5cbiAgICAgIGlmIChxdWVyeS5kaXJ0eSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmIChxdWVyeS5vcmRlcmVkKSB7XG4gICAgICAgIG1hdGNoZWRfYmVmb3JlW3FpZF0gPSBxdWVyeS5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpLnJlc3VsdDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEJlY2F1c2Ugd2UgZG9uJ3Qgc3VwcG9ydCBza2lwIG9yIGxpbWl0ICh5ZXQpIGluIHVub3JkZXJlZCBxdWVyaWVzLCB3ZVxuICAgICAgICAvLyBjYW4ganVzdCBkbyBhIGRpcmVjdCBsb29rdXAuXG4gICAgICAgIG1hdGNoZWRfYmVmb3JlW3FpZF0gPSBxdWVyeS5yZXN1bHRzLmhhcyhkb2MuX2lkKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IG9sZF9kb2MgPSBFSlNPTi5jbG9uZShkb2MpO1xuXG4gICAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkoZG9jLCBtb2QsIHthcnJheUluZGljZXN9KTtcblxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgYWZ0ZXJNYXRjaCA9IHF1ZXJ5Lm1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGRvYyk7XG4gICAgICBjb25zdCBhZnRlciA9IGFmdGVyTWF0Y2gucmVzdWx0O1xuICAgICAgY29uc3QgYmVmb3JlID0gbWF0Y2hlZF9iZWZvcmVbcWlkXTtcblxuICAgICAgaWYgKGFmdGVyICYmIHF1ZXJ5LmRpc3RhbmNlcyAmJiBhZnRlck1hdGNoLmRpc3RhbmNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcXVlcnkuZGlzdGFuY2VzLnNldChkb2MuX2lkLCBhZnRlck1hdGNoLmRpc3RhbmNlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHF1ZXJ5LmN1cnNvci5za2lwIHx8IHF1ZXJ5LmN1cnNvci5saW1pdCkge1xuICAgICAgICAvLyBXZSBuZWVkIHRvIHJlY29tcHV0ZSBhbnkgcXVlcnkgd2hlcmUgdGhlIGRvYyBtYXkgaGF2ZSBiZWVuIGluIHRoZVxuICAgICAgICAvLyBjdXJzb3IncyB3aW5kb3cgZWl0aGVyIGJlZm9yZSBvciBhZnRlciB0aGUgdXBkYXRlLiAoTm90ZSB0aGF0IGlmIHNraXBcbiAgICAgICAgLy8gb3IgbGltaXQgaXMgc2V0LCBcImJlZm9yZVwiIGFuZCBcImFmdGVyXCIgYmVpbmcgdHJ1ZSBkbyBub3QgbmVjZXNzYXJpbHlcbiAgICAgICAgLy8gbWVhbiB0aGF0IHRoZSBkb2N1bWVudCBpcyBpbiB0aGUgY3Vyc29yJ3Mgb3V0cHV0IGFmdGVyIHNraXAvbGltaXQgaXNcbiAgICAgICAgLy8gYXBwbGllZC4uLiBidXQgaWYgdGhleSBhcmUgZmFsc2UsIHRoZW4gdGhlIGRvY3VtZW50IGRlZmluaXRlbHkgaXMgTk9UXG4gICAgICAgIC8vIGluIHRoZSBvdXRwdXQuIFNvIGl0J3Mgc2FmZSB0byBza2lwIHJlY29tcHV0ZSBpZiBuZWl0aGVyIGJlZm9yZSBvclxuICAgICAgICAvLyBhZnRlciBhcmUgdHJ1ZS4pXG4gICAgICAgIGlmIChiZWZvcmUgfHwgYWZ0ZXIpIHtcbiAgICAgICAgICByZWNvbXB1dGVRaWRzW3FpZF0gPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGJlZm9yZSAmJiAhYWZ0ZXIpIHtcbiAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9yZW1vdmVGcm9tUmVzdWx0cyhxdWVyeSwgZG9jKTtcbiAgICAgIH0gZWxzZSBpZiAoIWJlZm9yZSAmJiBhZnRlcikge1xuICAgICAgICBMb2NhbENvbGxlY3Rpb24uX2luc2VydEluUmVzdWx0cyhxdWVyeSwgZG9jKTtcbiAgICAgIH0gZWxzZSBpZiAoYmVmb3JlICYmIGFmdGVyKSB7XG4gICAgICAgIExvY2FsQ29sbGVjdGlvbi5fdXBkYXRlSW5SZXN1bHRzKHF1ZXJ5LCBkb2MsIG9sZF9kb2MpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gUmVjb21wdXRlcyB0aGUgcmVzdWx0cyBvZiBhIHF1ZXJ5IGFuZCBydW5zIG9ic2VydmUgY2FsbGJhY2tzIGZvciB0aGVcbiAgLy8gZGlmZmVyZW5jZSBiZXR3ZWVuIHRoZSBwcmV2aW91cyByZXN1bHRzIGFuZCB0aGUgY3VycmVudCByZXN1bHRzICh1bmxlc3NcbiAgLy8gcGF1c2VkKS4gVXNlZCBmb3Igc2tpcC9saW1pdCBxdWVyaWVzLlxuICAvL1xuICAvLyBXaGVuIHRoaXMgaXMgdXNlZCBieSBpbnNlcnQgb3IgcmVtb3ZlLCBpdCBjYW4ganVzdCB1c2UgcXVlcnkucmVzdWx0cyBmb3JcbiAgLy8gdGhlIG9sZCByZXN1bHRzIChhbmQgdGhlcmUncyBubyBuZWVkIHRvIHBhc3MgaW4gb2xkUmVzdWx0cyksIGJlY2F1c2UgdGhlc2VcbiAgLy8gb3BlcmF0aW9ucyBkb24ndCBtdXRhdGUgdGhlIGRvY3VtZW50cyBpbiB0aGUgY29sbGVjdGlvbi4gVXBkYXRlIG5lZWRzIHRvXG4gIC8vIHBhc3MgaW4gYW4gb2xkUmVzdWx0cyB3aGljaCB3YXMgZGVlcC1jb3BpZWQgYmVmb3JlIHRoZSBtb2RpZmllciB3YXNcbiAgLy8gYXBwbGllZC5cbiAgLy9cbiAgLy8gb2xkUmVzdWx0cyBpcyBndWFyYW50ZWVkIHRvIGJlIGlnbm9yZWQgaWYgdGhlIHF1ZXJ5IGlzIG5vdCBwYXVzZWQuXG4gIF9yZWNvbXB1dGVSZXN1bHRzKHF1ZXJ5LCBvbGRSZXN1bHRzKSB7XG4gICAgaWYgKHRoaXMucGF1c2VkKSB7XG4gICAgICAvLyBUaGVyZSdzIG5vIHJlYXNvbiB0byByZWNvbXB1dGUgdGhlIHJlc3VsdHMgbm93IGFzIHdlJ3JlIHN0aWxsIHBhdXNlZC5cbiAgICAgIC8vIEJ5IGZsYWdnaW5nIHRoZSBxdWVyeSBhcyBcImRpcnR5XCIsIHRoZSByZWNvbXB1dGUgd2lsbCBiZSBwZXJmb3JtZWRcbiAgICAgIC8vIHdoZW4gcmVzdW1lT2JzZXJ2ZXJzIGlzIGNhbGxlZC5cbiAgICAgIHF1ZXJ5LmRpcnR5ID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMucGF1c2VkICYmICFvbGRSZXN1bHRzKSB7XG4gICAgICBvbGRSZXN1bHRzID0gcXVlcnkucmVzdWx0cztcbiAgICB9XG5cbiAgICBpZiAocXVlcnkuZGlzdGFuY2VzKSB7XG4gICAgICBxdWVyeS5kaXN0YW5jZXMuY2xlYXIoKTtcbiAgICB9XG5cbiAgICBxdWVyeS5yZXN1bHRzID0gcXVlcnkuY3Vyc29yLl9nZXRSYXdPYmplY3RzKHtcbiAgICAgIGRpc3RhbmNlczogcXVlcnkuZGlzdGFuY2VzLFxuICAgICAgb3JkZXJlZDogcXVlcnkub3JkZXJlZFxuICAgIH0pO1xuXG4gICAgaWYgKCF0aGlzLnBhdXNlZCkge1xuICAgICAgTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlDaGFuZ2VzKFxuICAgICAgICBxdWVyeS5vcmRlcmVkLFxuICAgICAgICBvbGRSZXN1bHRzLFxuICAgICAgICBxdWVyeS5yZXN1bHRzLFxuICAgICAgICBxdWVyeSxcbiAgICAgICAge3Byb2plY3Rpb25GbjogcXVlcnkucHJvamVjdGlvbkZufVxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBfc2F2ZU9yaWdpbmFsKGlkLCBkb2MpIHtcbiAgICAvLyBBcmUgd2UgZXZlbiB0cnlpbmcgdG8gc2F2ZSBvcmlnaW5hbHM/XG4gICAgaWYgKCF0aGlzLl9zYXZlZE9yaWdpbmFscykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEhhdmUgd2UgcHJldmlvdXNseSBtdXRhdGVkIHRoZSBvcmlnaW5hbCAoYW5kIHNvICdkb2MnIGlzIG5vdCBhY3R1YWxseVxuICAgIC8vIG9yaWdpbmFsKT8gIChOb3RlIHRoZSAnaGFzJyBjaGVjayByYXRoZXIgdGhhbiB0cnV0aDogd2Ugc3RvcmUgdW5kZWZpbmVkXG4gICAgLy8gaGVyZSBmb3IgaW5zZXJ0ZWQgZG9jcyEpXG4gICAgaWYgKHRoaXMuX3NhdmVkT3JpZ2luYWxzLmhhcyhpZCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLl9zYXZlZE9yaWdpbmFscy5zZXQoaWQsIEVKU09OLmNsb25lKGRvYykpO1xuICB9XG59XG5cbkxvY2FsQ29sbGVjdGlvbi5DdXJzb3IgPSBDdXJzb3I7XG5cbkxvY2FsQ29sbGVjdGlvbi5PYnNlcnZlSGFuZGxlID0gT2JzZXJ2ZUhhbmRsZTtcblxuLy8gWFhYIG1heWJlIG1vdmUgdGhlc2UgaW50byBhbm90aGVyIE9ic2VydmVIZWxwZXJzIHBhY2thZ2Ugb3Igc29tZXRoaW5nXG5cbi8vIF9DYWNoaW5nQ2hhbmdlT2JzZXJ2ZXIgaXMgYW4gb2JqZWN0IHdoaWNoIHJlY2VpdmVzIG9ic2VydmVDaGFuZ2VzIGNhbGxiYWNrc1xuLy8gYW5kIGtlZXBzIGEgY2FjaGUgb2YgdGhlIGN1cnJlbnQgY3Vyc29yIHN0YXRlIHVwIHRvIGRhdGUgaW4gdGhpcy5kb2NzLiBVc2Vyc1xuLy8gb2YgdGhpcyBjbGFzcyBzaG91bGQgcmVhZCB0aGUgZG9jcyBmaWVsZCBidXQgbm90IG1vZGlmeSBpdC4gWW91IHNob3VsZCBwYXNzXG4vLyB0aGUgXCJhcHBseUNoYW5nZVwiIGZpZWxkIGFzIHRoZSBjYWxsYmFja3MgdG8gdGhlIHVuZGVybHlpbmcgb2JzZXJ2ZUNoYW5nZXNcbi8vIGNhbGwuIE9wdGlvbmFsbHksIHlvdSBjYW4gc3BlY2lmeSB5b3VyIG93biBvYnNlcnZlQ2hhbmdlcyBjYWxsYmFja3Mgd2hpY2ggYXJlXG4vLyBpbnZva2VkIGltbWVkaWF0ZWx5IGJlZm9yZSB0aGUgZG9jcyBmaWVsZCBpcyB1cGRhdGVkOyB0aGlzIG9iamVjdCBpcyBtYWRlXG4vLyBhdmFpbGFibGUgYXMgYHRoaXNgIHRvIHRob3NlIGNhbGxiYWNrcy5cbkxvY2FsQ29sbGVjdGlvbi5fQ2FjaGluZ0NoYW5nZU9ic2VydmVyID0gY2xhc3MgX0NhY2hpbmdDaGFuZ2VPYnNlcnZlciB7XG4gIGNvbnN0cnVjdG9yKG9wdGlvbnMgPSB7fSkge1xuICAgIGNvbnN0IG9yZGVyZWRGcm9tQ2FsbGJhY2tzID0gKFxuICAgICAgb3B0aW9ucy5jYWxsYmFja3MgJiZcbiAgICAgIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkKG9wdGlvbnMuY2FsbGJhY2tzKVxuICAgICk7XG5cbiAgICBpZiAoaGFzT3duLmNhbGwob3B0aW9ucywgJ29yZGVyZWQnKSkge1xuICAgICAgdGhpcy5vcmRlcmVkID0gb3B0aW9ucy5vcmRlcmVkO1xuXG4gICAgICBpZiAob3B0aW9ucy5jYWxsYmFja3MgJiYgb3B0aW9ucy5vcmRlcmVkICE9PSBvcmRlcmVkRnJvbUNhbGxiYWNrcykge1xuICAgICAgICB0aHJvdyBFcnJvcignb3JkZXJlZCBvcHRpb24gZG9lc25cXCd0IG1hdGNoIGNhbGxiYWNrcycpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAob3B0aW9ucy5jYWxsYmFja3MpIHtcbiAgICAgIHRoaXMub3JkZXJlZCA9IG9yZGVyZWRGcm9tQ2FsbGJhY2tzO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBFcnJvcignbXVzdCBwcm92aWRlIG9yZGVyZWQgb3IgY2FsbGJhY2tzJyk7XG4gICAgfVxuXG4gICAgY29uc3QgY2FsbGJhY2tzID0gb3B0aW9ucy5jYWxsYmFja3MgfHwge307XG5cbiAgICBpZiAodGhpcy5vcmRlcmVkKSB7XG4gICAgICB0aGlzLmRvY3MgPSBuZXcgT3JkZXJlZERpY3QoTW9uZ29JRC5pZFN0cmluZ2lmeSk7XG4gICAgICB0aGlzLmFwcGx5Q2hhbmdlID0ge1xuICAgICAgICBhZGRlZEJlZm9yZTogKGlkLCBmaWVsZHMsIGJlZm9yZSkgPT4ge1xuICAgICAgICAgIC8vIFRha2UgYSBzaGFsbG93IGNvcHkgc2luY2UgdGhlIHRvcC1sZXZlbCBwcm9wZXJ0aWVzIGNhbiBiZSBjaGFuZ2VkXG4gICAgICAgICAgY29uc3QgZG9jID0geyAuLi5maWVsZHMgfTtcblxuICAgICAgICAgIGRvYy5faWQgPSBpZDtcblxuICAgICAgICAgIGlmIChjYWxsYmFja3MuYWRkZWRCZWZvcmUpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrcy5hZGRlZEJlZm9yZS5jYWxsKHRoaXMsIGlkLCBFSlNPTi5jbG9uZShmaWVsZHMpLCBiZWZvcmUpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFRoaXMgbGluZSB0cmlnZ2VycyBpZiB3ZSBwcm92aWRlIGFkZGVkIHdpdGggbW92ZWRCZWZvcmUuXG4gICAgICAgICAgaWYgKGNhbGxiYWNrcy5hZGRlZCkge1xuICAgICAgICAgICAgY2FsbGJhY2tzLmFkZGVkLmNhbGwodGhpcywgaWQsIEVKU09OLmNsb25lKGZpZWxkcykpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFhYWCBjb3VsZCBgYmVmb3JlYCBiZSBhIGZhbHN5IElEPyAgVGVjaG5pY2FsbHlcbiAgICAgICAgICAvLyBpZFN0cmluZ2lmeSBzZWVtcyB0byBhbGxvdyBmb3IgdGhlbSAtLSB0aG91Z2hcbiAgICAgICAgICAvLyBPcmRlcmVkRGljdCB3b24ndCBjYWxsIHN0cmluZ2lmeSBvbiBhIGZhbHN5IGFyZy5cbiAgICAgICAgICB0aGlzLmRvY3MucHV0QmVmb3JlKGlkLCBkb2MsIGJlZm9yZSB8fCBudWxsKTtcbiAgICAgICAgfSxcbiAgICAgICAgbW92ZWRCZWZvcmU6IChpZCwgYmVmb3JlKSA9PiB7XG4gICAgICAgICAgY29uc3QgZG9jID0gdGhpcy5kb2NzLmdldChpZCk7XG5cbiAgICAgICAgICBpZiAoY2FsbGJhY2tzLm1vdmVkQmVmb3JlKSB7XG4gICAgICAgICAgICBjYWxsYmFja3MubW92ZWRCZWZvcmUuY2FsbCh0aGlzLCBpZCwgYmVmb3JlKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICB0aGlzLmRvY3MubW92ZUJlZm9yZShpZCwgYmVmb3JlIHx8IG51bGwpO1xuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5kb2NzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gICAgICB0aGlzLmFwcGx5Q2hhbmdlID0ge1xuICAgICAgICBhZGRlZDogKGlkLCBmaWVsZHMpID0+IHtcbiAgICAgICAgICAvLyBUYWtlIGEgc2hhbGxvdyBjb3B5IHNpbmNlIHRoZSB0b3AtbGV2ZWwgcHJvcGVydGllcyBjYW4gYmUgY2hhbmdlZFxuICAgICAgICAgIGNvbnN0IGRvYyA9IHsgLi4uZmllbGRzIH07XG5cbiAgICAgICAgICBpZiAoY2FsbGJhY2tzLmFkZGVkKSB7XG4gICAgICAgICAgICBjYWxsYmFja3MuYWRkZWQuY2FsbCh0aGlzLCBpZCwgRUpTT04uY2xvbmUoZmllbGRzKSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZG9jLl9pZCA9IGlkO1xuXG4gICAgICAgICAgdGhpcy5kb2NzLnNldChpZCwgIGRvYyk7XG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIFRoZSBtZXRob2RzIGluIF9JZE1hcCBhbmQgT3JkZXJlZERpY3QgdXNlZCBieSB0aGVzZSBjYWxsYmFja3MgYXJlXG4gICAgLy8gaWRlbnRpY2FsLlxuICAgIHRoaXMuYXBwbHlDaGFuZ2UuY2hhbmdlZCA9IChpZCwgZmllbGRzKSA9PiB7XG4gICAgICBjb25zdCBkb2MgPSB0aGlzLmRvY3MuZ2V0KGlkKTtcblxuICAgICAgaWYgKCFkb2MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGlkIGZvciBjaGFuZ2VkOiAke2lkfWApO1xuICAgICAgfVxuXG4gICAgICBpZiAoY2FsbGJhY2tzLmNoYW5nZWQpIHtcbiAgICAgICAgY2FsbGJhY2tzLmNoYW5nZWQuY2FsbCh0aGlzLCBpZCwgRUpTT04uY2xvbmUoZmllbGRzKSk7XG4gICAgICB9XG5cbiAgICAgIERpZmZTZXF1ZW5jZS5hcHBseUNoYW5nZXMoZG9jLCBmaWVsZHMpO1xuICAgIH07XG5cbiAgICB0aGlzLmFwcGx5Q2hhbmdlLnJlbW92ZWQgPSBpZCA9PiB7XG4gICAgICBpZiAoY2FsbGJhY2tzLnJlbW92ZWQpIHtcbiAgICAgICAgY2FsbGJhY2tzLnJlbW92ZWQuY2FsbCh0aGlzLCBpZCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuZG9jcy5yZW1vdmUoaWQpO1xuICAgIH07XG4gIH1cbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fSWRNYXAgPSBjbGFzcyBfSWRNYXAgZXh0ZW5kcyBJZE1hcCB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKE1vbmdvSUQuaWRTdHJpbmdpZnksIE1vbmdvSUQuaWRQYXJzZSk7XG4gIH1cbn07XG5cbi8vIFdyYXAgYSB0cmFuc2Zvcm0gZnVuY3Rpb24gdG8gcmV0dXJuIG9iamVjdHMgdGhhdCBoYXZlIHRoZSBfaWQgZmllbGRcbi8vIG9mIHRoZSB1bnRyYW5zZm9ybWVkIGRvY3VtZW50LiBUaGlzIGVuc3VyZXMgdGhhdCBzdWJzeXN0ZW1zIHN1Y2ggYXNcbi8vIHRoZSBvYnNlcnZlLXNlcXVlbmNlIHBhY2thZ2UgdGhhdCBjYWxsIGBvYnNlcnZlYCBjYW4ga2VlcCB0cmFjayBvZlxuLy8gdGhlIGRvY3VtZW50cyBpZGVudGl0aWVzLlxuLy9cbi8vIC0gUmVxdWlyZSB0aGF0IGl0IHJldHVybnMgb2JqZWN0c1xuLy8gLSBJZiB0aGUgcmV0dXJuIHZhbHVlIGhhcyBhbiBfaWQgZmllbGQsIHZlcmlmeSB0aGF0IGl0IG1hdGNoZXMgdGhlXG4vLyAgIG9yaWdpbmFsIF9pZCBmaWVsZFxuLy8gLSBJZiB0aGUgcmV0dXJuIHZhbHVlIGRvZXNuJ3QgaGF2ZSBhbiBfaWQgZmllbGQsIGFkZCBpdCBiYWNrLlxuTG9jYWxDb2xsZWN0aW9uLndyYXBUcmFuc2Zvcm0gPSB0cmFuc2Zvcm0gPT4ge1xuICBpZiAoIXRyYW5zZm9ybSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgLy8gTm8gbmVlZCB0byBkb3VibHktd3JhcCB0cmFuc2Zvcm1zLlxuICBpZiAodHJhbnNmb3JtLl9fd3JhcHBlZFRyYW5zZm9ybV9fKSB7XG4gICAgcmV0dXJuIHRyYW5zZm9ybTtcbiAgfVxuXG4gIGNvbnN0IHdyYXBwZWQgPSBkb2MgPT4ge1xuICAgIGlmICghaGFzT3duLmNhbGwoZG9jLCAnX2lkJykpIHtcbiAgICAgIC8vIFhYWCBkbyB3ZSBldmVyIGhhdmUgYSB0cmFuc2Zvcm0gb24gdGhlIG9wbG9nJ3MgY29sbGVjdGlvbj8gYmVjYXVzZSB0aGF0XG4gICAgICAvLyBjb2xsZWN0aW9uIGhhcyBubyBfaWQuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ2NhbiBvbmx5IHRyYW5zZm9ybSBkb2N1bWVudHMgd2l0aCBfaWQnKTtcbiAgICB9XG5cbiAgICBjb25zdCBpZCA9IGRvYy5faWQ7XG5cbiAgICAvLyBYWFggY29uc2lkZXIgbWFraW5nIHRyYWNrZXIgYSB3ZWFrIGRlcGVuZGVuY3kgYW5kIGNoZWNraW5nXG4gICAgLy8gUGFja2FnZS50cmFja2VyIGhlcmVcbiAgICBjb25zdCB0cmFuc2Zvcm1lZCA9IFRyYWNrZXIubm9ucmVhY3RpdmUoKCkgPT4gdHJhbnNmb3JtKGRvYykpO1xuXG4gICAgaWYgKCFMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QodHJhbnNmb3JtZWQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RyYW5zZm9ybSBtdXN0IHJldHVybiBvYmplY3QnKTtcbiAgICB9XG5cbiAgICBpZiAoaGFzT3duLmNhbGwodHJhbnNmb3JtZWQsICdfaWQnKSkge1xuICAgICAgaWYgKCFFSlNPTi5lcXVhbHModHJhbnNmb3JtZWQuX2lkLCBpZCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0cmFuc2Zvcm1lZCBkb2N1bWVudCBjYW5cXCd0IGhhdmUgZGlmZmVyZW50IF9pZCcpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0cmFuc2Zvcm1lZC5faWQgPSBpZDtcbiAgICB9XG5cbiAgICByZXR1cm4gdHJhbnNmb3JtZWQ7XG4gIH07XG5cbiAgd3JhcHBlZC5fX3dyYXBwZWRUcmFuc2Zvcm1fXyA9IHRydWU7XG5cbiAgcmV0dXJuIHdyYXBwZWQ7XG59O1xuXG4vLyBYWFggdGhlIHNvcnRlZC1xdWVyeSBsb2dpYyBiZWxvdyBpcyBsYXVnaGFibHkgaW5lZmZpY2llbnQuIHdlJ2xsXG4vLyBuZWVkIHRvIGNvbWUgdXAgd2l0aCBhIGJldHRlciBkYXRhc3RydWN0dXJlIGZvciB0aGlzLlxuLy9cbi8vIFhYWCB0aGUgbG9naWMgZm9yIG9ic2VydmluZyB3aXRoIGEgc2tpcCBvciBhIGxpbWl0IGlzIGV2ZW4gbW9yZVxuLy8gbGF1Z2hhYmx5IGluZWZmaWNpZW50LiB3ZSByZWNvbXB1dGUgdGhlIHdob2xlIHJlc3VsdHMgZXZlcnkgdGltZSFcblxuLy8gVGhpcyBiaW5hcnkgc2VhcmNoIHB1dHMgYSB2YWx1ZSBiZXR3ZWVuIGFueSBlcXVhbCB2YWx1ZXMsIGFuZCB0aGUgZmlyc3Rcbi8vIGxlc3NlciB2YWx1ZS5cbkxvY2FsQ29sbGVjdGlvbi5fYmluYXJ5U2VhcmNoID0gKGNtcCwgYXJyYXksIHZhbHVlKSA9PiB7XG4gIGxldCBmaXJzdCA9IDA7XG4gIGxldCByYW5nZSA9IGFycmF5Lmxlbmd0aDtcblxuICB3aGlsZSAocmFuZ2UgPiAwKSB7XG4gICAgY29uc3QgaGFsZlJhbmdlID0gTWF0aC5mbG9vcihyYW5nZSAvIDIpO1xuXG4gICAgaWYgKGNtcCh2YWx1ZSwgYXJyYXlbZmlyc3QgKyBoYWxmUmFuZ2VdKSA+PSAwKSB7XG4gICAgICBmaXJzdCArPSBoYWxmUmFuZ2UgKyAxO1xuICAgICAgcmFuZ2UgLT0gaGFsZlJhbmdlICsgMTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmFuZ2UgPSBoYWxmUmFuZ2U7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGZpcnN0O1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9jaGVja1N1cHBvcnRlZFByb2plY3Rpb24gPSBmaWVsZHMgPT4ge1xuICBpZiAoZmllbGRzICE9PSBPYmplY3QoZmllbGRzKSB8fCBBcnJheS5pc0FycmF5KGZpZWxkcykpIHtcbiAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignZmllbGRzIG9wdGlvbiBtdXN0IGJlIGFuIG9iamVjdCcpO1xuICB9XG5cbiAgT2JqZWN0LmtleXMoZmllbGRzKS5mb3JFYWNoKGtleVBhdGggPT4ge1xuICAgIGlmIChrZXlQYXRoLnNwbGl0KCcuJykuaW5jbHVkZXMoJyQnKSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdNaW5pbW9uZ28gZG9lc25cXCd0IHN1cHBvcnQgJCBvcGVyYXRvciBpbiBwcm9qZWN0aW9ucyB5ZXQuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB2YWx1ZSA9IGZpZWxkc1trZXlQYXRoXTtcblxuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmXG4gICAgICAgIFsnJGVsZW1NYXRjaCcsICckbWV0YScsICckc2xpY2UnXS5zb21lKGtleSA9PlxuICAgICAgICAgIGhhc093bi5jYWxsKHZhbHVlLCBrZXkpXG4gICAgICAgICkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnTWluaW1vbmdvIGRvZXNuXFwndCBzdXBwb3J0IG9wZXJhdG9ycyBpbiBwcm9qZWN0aW9ucyB5ZXQuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIVsxLCAwLCB0cnVlLCBmYWxzZV0uaW5jbHVkZXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ1Byb2plY3Rpb24gdmFsdWVzIHNob3VsZCBiZSBvbmUgb2YgMSwgMCwgdHJ1ZSwgb3IgZmFsc2UnXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG59O1xuXG4vLyBLbm93cyBob3cgdG8gY29tcGlsZSBhIGZpZWxkcyBwcm9qZWN0aW9uIHRvIGEgcHJlZGljYXRlIGZ1bmN0aW9uLlxuLy8gQHJldHVybnMgLSBGdW5jdGlvbjogYSBjbG9zdXJlIHRoYXQgZmlsdGVycyBvdXQgYW4gb2JqZWN0IGFjY29yZGluZyB0byB0aGVcbi8vICAgICAgICAgICAgZmllbGRzIHByb2plY3Rpb24gcnVsZXM6XG4vLyAgICAgICAgICAgIEBwYXJhbSBvYmogLSBPYmplY3Q6IE1vbmdvREItc3R5bGVkIGRvY3VtZW50XG4vLyAgICAgICAgICAgIEByZXR1cm5zIC0gT2JqZWN0OiBhIGRvY3VtZW50IHdpdGggdGhlIGZpZWxkcyBmaWx0ZXJlZCBvdXRcbi8vICAgICAgICAgICAgICAgICAgICAgICBhY2NvcmRpbmcgdG8gcHJvamVjdGlvbiBydWxlcy4gRG9lc24ndCByZXRhaW4gc3ViZmllbGRzXG4vLyAgICAgICAgICAgICAgICAgICAgICAgb2YgcGFzc2VkIGFyZ3VtZW50LlxuTG9jYWxDb2xsZWN0aW9uLl9jb21waWxlUHJvamVjdGlvbiA9IGZpZWxkcyA9PiB7XG4gIExvY2FsQ29sbGVjdGlvbi5fY2hlY2tTdXBwb3J0ZWRQcm9qZWN0aW9uKGZpZWxkcyk7XG5cbiAgY29uc3QgX2lkUHJvamVjdGlvbiA9IGZpZWxkcy5faWQgPT09IHVuZGVmaW5lZCA/IHRydWUgOiBmaWVsZHMuX2lkO1xuICBjb25zdCBkZXRhaWxzID0gcHJvamVjdGlvbkRldGFpbHMoZmllbGRzKTtcblxuICAvLyByZXR1cm5zIHRyYW5zZm9ybWVkIGRvYyBhY2NvcmRpbmcgdG8gcnVsZVRyZWVcbiAgY29uc3QgdHJhbnNmb3JtID0gKGRvYywgcnVsZVRyZWUpID0+IHtcbiAgICAvLyBTcGVjaWFsIGNhc2UgZm9yIFwic2V0c1wiXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoZG9jKSkge1xuICAgICAgcmV0dXJuIGRvYy5tYXAoc3ViZG9jID0+IHRyYW5zZm9ybShzdWJkb2MsIHJ1bGVUcmVlKSk7XG4gICAgfVxuXG4gICAgY29uc3QgcmVzdWx0ID0gZGV0YWlscy5pbmNsdWRpbmcgPyB7fSA6IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICBPYmplY3Qua2V5cyhydWxlVHJlZSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgaWYgKGRvYyA9PSBudWxsIHx8ICFoYXNPd24uY2FsbChkb2MsIGtleSkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBydWxlID0gcnVsZVRyZWVba2V5XTtcblxuICAgICAgaWYgKHJ1bGUgPT09IE9iamVjdChydWxlKSkge1xuICAgICAgICAvLyBGb3Igc3ViLW9iamVjdHMvc3Vic2V0cyB3ZSBicmFuY2hcbiAgICAgICAgaWYgKGRvY1trZXldID09PSBPYmplY3QoZG9jW2tleV0pKSB7XG4gICAgICAgICAgcmVzdWx0W2tleV0gPSB0cmFuc2Zvcm0oZG9jW2tleV0sIHJ1bGUpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGRldGFpbHMuaW5jbHVkaW5nKSB7XG4gICAgICAgIC8vIE90aGVyd2lzZSB3ZSBkb24ndCBldmVuIHRvdWNoIHRoaXMgc3ViZmllbGRcbiAgICAgICAgcmVzdWx0W2tleV0gPSBFSlNPTi5jbG9uZShkb2Nba2V5XSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWxldGUgcmVzdWx0W2tleV07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gZG9jICE9IG51bGwgPyByZXN1bHQgOiBkb2M7XG4gIH07XG5cbiAgcmV0dXJuIGRvYyA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdHJhbnNmb3JtKGRvYywgZGV0YWlscy50cmVlKTtcblxuICAgIGlmIChfaWRQcm9qZWN0aW9uICYmIGhhc093bi5jYWxsKGRvYywgJ19pZCcpKSB7XG4gICAgICByZXN1bHQuX2lkID0gZG9jLl9pZDtcbiAgICB9XG5cbiAgICBpZiAoIV9pZFByb2plY3Rpb24gJiYgaGFzT3duLmNhbGwocmVzdWx0LCAnX2lkJykpIHtcbiAgICAgIGRlbGV0ZSByZXN1bHQuX2lkO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH07XG59O1xuXG4vLyBDYWxjdWxhdGVzIHRoZSBkb2N1bWVudCB0byBpbnNlcnQgaW4gY2FzZSB3ZSdyZSBkb2luZyBhbiB1cHNlcnQgYW5kIHRoZVxuLy8gc2VsZWN0b3IgZG9lcyBub3QgbWF0Y2ggYW55IGVsZW1lbnRzXG5Mb2NhbENvbGxlY3Rpb24uX2NyZWF0ZVVwc2VydERvY3VtZW50ID0gKHNlbGVjdG9yLCBtb2RpZmllcikgPT4ge1xuICBjb25zdCBzZWxlY3RvckRvY3VtZW50ID0gcG9wdWxhdGVEb2N1bWVudFdpdGhRdWVyeUZpZWxkcyhzZWxlY3Rvcik7XG4gIGNvbnN0IGlzTW9kaWZ5ID0gTG9jYWxDb2xsZWN0aW9uLl9pc01vZGlmaWNhdGlvbk1vZChtb2RpZmllcik7XG5cbiAgY29uc3QgbmV3RG9jID0ge307XG5cbiAgaWYgKHNlbGVjdG9yRG9jdW1lbnQuX2lkKSB7XG4gICAgbmV3RG9jLl9pZCA9IHNlbGVjdG9yRG9jdW1lbnQuX2lkO1xuICAgIGRlbGV0ZSBzZWxlY3RvckRvY3VtZW50Ll9pZDtcbiAgfVxuXG4gIC8vIFRoaXMgZG91YmxlIF9tb2RpZnkgY2FsbCBpcyBtYWRlIHRvIGhlbHAgd2l0aCBuZXN0ZWQgcHJvcGVydGllcyAoc2VlIGlzc3VlXG4gIC8vICM4NjMxKS4gV2UgZG8gdGhpcyBldmVuIGlmIGl0J3MgYSByZXBsYWNlbWVudCBmb3IgdmFsaWRhdGlvbiBwdXJwb3NlcyAoZS5nLlxuICAvLyBhbWJpZ3VvdXMgaWQncylcbiAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkobmV3RG9jLCB7JHNldDogc2VsZWN0b3JEb2N1bWVudH0pO1xuICBMb2NhbENvbGxlY3Rpb24uX21vZGlmeShuZXdEb2MsIG1vZGlmaWVyLCB7aXNJbnNlcnQ6IHRydWV9KTtcblxuICBpZiAoaXNNb2RpZnkpIHtcbiAgICByZXR1cm4gbmV3RG9jO1xuICB9XG5cbiAgLy8gUmVwbGFjZW1lbnQgY2FuIHRha2UgX2lkIGZyb20gcXVlcnkgZG9jdW1lbnRcbiAgY29uc3QgcmVwbGFjZW1lbnQgPSBPYmplY3QuYXNzaWduKHt9LCBtb2RpZmllcik7XG4gIGlmIChuZXdEb2MuX2lkKSB7XG4gICAgcmVwbGFjZW1lbnQuX2lkID0gbmV3RG9jLl9pZDtcbiAgfVxuXG4gIHJldHVybiByZXBsYWNlbWVudDtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fZGlmZk9iamVjdHMgPSAobGVmdCwgcmlnaHQsIGNhbGxiYWNrcykgPT4ge1xuICByZXR1cm4gRGlmZlNlcXVlbmNlLmRpZmZPYmplY3RzKGxlZnQsIHJpZ2h0LCBjYWxsYmFja3MpO1xufTtcblxuLy8gb3JkZXJlZDogYm9vbC5cbi8vIG9sZF9yZXN1bHRzIGFuZCBuZXdfcmVzdWx0czogY29sbGVjdGlvbnMgb2YgZG9jdW1lbnRzLlxuLy8gICAgaWYgb3JkZXJlZCwgdGhleSBhcmUgYXJyYXlzLlxuLy8gICAgaWYgdW5vcmRlcmVkLCB0aGV5IGFyZSBJZE1hcHNcbkxvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5Q2hhbmdlcyA9IChvcmRlcmVkLCBvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucykgPT5cbiAgRGlmZlNlcXVlbmNlLmRpZmZRdWVyeUNoYW5nZXMob3JkZXJlZCwgb2xkUmVzdWx0cywgbmV3UmVzdWx0cywgb2JzZXJ2ZXIsIG9wdGlvbnMpXG47XG5cbkxvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5T3JkZXJlZENoYW5nZXMgPSAob2xkUmVzdWx0cywgbmV3UmVzdWx0cywgb2JzZXJ2ZXIsIG9wdGlvbnMpID0+XG4gIERpZmZTZXF1ZW5jZS5kaWZmUXVlcnlPcmRlcmVkQ2hhbmdlcyhvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucylcbjtcblxuTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzID0gKG9sZFJlc3VsdHMsIG5ld1Jlc3VsdHMsIG9ic2VydmVyLCBvcHRpb25zKSA9PlxuICBEaWZmU2VxdWVuY2UuZGlmZlF1ZXJ5VW5vcmRlcmVkQ2hhbmdlcyhvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucylcbjtcblxuTG9jYWxDb2xsZWN0aW9uLl9maW5kSW5PcmRlcmVkUmVzdWx0cyA9IChxdWVyeSwgZG9jKSA9PiB7XG4gIGlmICghcXVlcnkub3JkZXJlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcignQ2FuXFwndCBjYWxsIF9maW5kSW5PcmRlcmVkUmVzdWx0cyBvbiB1bm9yZGVyZWQgcXVlcnknKTtcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcXVlcnkucmVzdWx0cy5sZW5ndGg7IGkrKykge1xuICAgIGlmIChxdWVyeS5yZXN1bHRzW2ldID09PSBkb2MpIHtcbiAgICAgIHJldHVybiBpO1xuICAgIH1cbiAgfVxuXG4gIHRocm93IEVycm9yKCdvYmplY3QgbWlzc2luZyBmcm9tIHF1ZXJ5Jyk7XG59O1xuXG4vLyBJZiB0aGlzIGlzIGEgc2VsZWN0b3Igd2hpY2ggZXhwbGljaXRseSBjb25zdHJhaW5zIHRoZSBtYXRjaCBieSBJRCB0byBhIGZpbml0ZVxuLy8gbnVtYmVyIG9mIGRvY3VtZW50cywgcmV0dXJucyBhIGxpc3Qgb2YgdGhlaXIgSURzLiAgT3RoZXJ3aXNlIHJldHVybnNcbi8vIG51bGwuIE5vdGUgdGhhdCB0aGUgc2VsZWN0b3IgbWF5IGhhdmUgb3RoZXIgcmVzdHJpY3Rpb25zIHNvIGl0IG1heSBub3QgZXZlblxuLy8gbWF0Y2ggdGhvc2UgZG9jdW1lbnQhICBXZSBjYXJlIGFib3V0ICRpbiBhbmQgJGFuZCBzaW5jZSB0aG9zZSBhcmUgZ2VuZXJhdGVkXG4vLyBhY2Nlc3MtY29udHJvbGxlZCB1cGRhdGUgYW5kIHJlbW92ZS5cbkxvY2FsQ29sbGVjdGlvbi5faWRzTWF0Y2hlZEJ5U2VsZWN0b3IgPSBzZWxlY3RvciA9PiB7XG4gIC8vIElzIHRoZSBzZWxlY3RvciBqdXN0IGFuIElEP1xuICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpKSB7XG4gICAgcmV0dXJuIFtzZWxlY3Rvcl07XG4gIH1cblxuICBpZiAoIXNlbGVjdG9yKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBEbyB3ZSBoYXZlIGFuIF9pZCBjbGF1c2U/XG4gIGlmIChoYXNPd24uY2FsbChzZWxlY3RvciwgJ19pZCcpKSB7XG4gICAgLy8gSXMgdGhlIF9pZCBjbGF1c2UganVzdCBhbiBJRD9cbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IuX2lkKSkge1xuICAgICAgcmV0dXJuIFtzZWxlY3Rvci5faWRdO1xuICAgIH1cblxuICAgIC8vIElzIHRoZSBfaWQgY2xhdXNlIHtfaWQ6IHskaW46IFtcInhcIiwgXCJ5XCIsIFwielwiXX19P1xuICAgIGlmIChzZWxlY3Rvci5faWRcbiAgICAgICAgJiYgQXJyYXkuaXNBcnJheShzZWxlY3Rvci5faWQuJGluKVxuICAgICAgICAmJiBzZWxlY3Rvci5faWQuJGluLmxlbmd0aFxuICAgICAgICAmJiBzZWxlY3Rvci5faWQuJGluLmV2ZXJ5KExvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkKSkge1xuICAgICAgcmV0dXJuIHNlbGVjdG9yLl9pZC4kaW47XG4gICAgfVxuXG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBJZiB0aGlzIGlzIGEgdG9wLWxldmVsICRhbmQsIGFuZCBhbnkgb2YgdGhlIGNsYXVzZXMgY29uc3RyYWluIHRoZWlyXG4gIC8vIGRvY3VtZW50cywgdGhlbiB0aGUgd2hvbGUgc2VsZWN0b3IgaXMgY29uc3RyYWluZWQgYnkgYW55IG9uZSBjbGF1c2Unc1xuICAvLyBjb25zdHJhaW50LiAoV2VsbCwgYnkgdGhlaXIgaW50ZXJzZWN0aW9uLCBidXQgdGhhdCBzZWVtcyB1bmxpa2VseS4pXG4gIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdG9yLiRhbmQpKSB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzZWxlY3Rvci4kYW5kLmxlbmd0aDsgKytpKSB7XG4gICAgICBjb25zdCBzdWJJZHMgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKHNlbGVjdG9yLiRhbmRbaV0pO1xuXG4gICAgICBpZiAoc3ViSWRzKSB7XG4gICAgICAgIHJldHVybiBzdWJJZHM7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2luc2VydEluUmVzdWx0cyA9IChxdWVyeSwgZG9jKSA9PiB7XG4gIGNvbnN0IGZpZWxkcyA9IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgZGVsZXRlIGZpZWxkcy5faWQ7XG5cbiAgaWYgKHF1ZXJ5Lm9yZGVyZWQpIHtcbiAgICBpZiAoIXF1ZXJ5LnNvcnRlcikge1xuICAgICAgcXVlcnkuYWRkZWRCZWZvcmUoZG9jLl9pZCwgcXVlcnkucHJvamVjdGlvbkZuKGZpZWxkcyksIG51bGwpO1xuICAgICAgcXVlcnkucmVzdWx0cy5wdXNoKGRvYyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGkgPSBMb2NhbENvbGxlY3Rpb24uX2luc2VydEluU29ydGVkTGlzdChcbiAgICAgICAgcXVlcnkuc29ydGVyLmdldENvbXBhcmF0b3Ioe2Rpc3RhbmNlczogcXVlcnkuZGlzdGFuY2VzfSksXG4gICAgICAgIHF1ZXJ5LnJlc3VsdHMsXG4gICAgICAgIGRvY1xuICAgICAgKTtcblxuICAgICAgbGV0IG5leHQgPSBxdWVyeS5yZXN1bHRzW2kgKyAxXTtcbiAgICAgIGlmIChuZXh0KSB7XG4gICAgICAgIG5leHQgPSBuZXh0Ll9pZDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG5leHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBxdWVyeS5hZGRlZEJlZm9yZShkb2MuX2lkLCBxdWVyeS5wcm9qZWN0aW9uRm4oZmllbGRzKSwgbmV4dCk7XG4gICAgfVxuXG4gICAgcXVlcnkuYWRkZWQoZG9jLl9pZCwgcXVlcnkucHJvamVjdGlvbkZuKGZpZWxkcykpO1xuICB9IGVsc2Uge1xuICAgIHF1ZXJ5LmFkZGVkKGRvYy5faWQsIHF1ZXJ5LnByb2plY3Rpb25GbihmaWVsZHMpKTtcbiAgICBxdWVyeS5yZXN1bHRzLnNldChkb2MuX2lkLCBkb2MpO1xuICB9XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2luc2VydEluU29ydGVkTGlzdCA9IChjbXAsIGFycmF5LCB2YWx1ZSkgPT4ge1xuICBpZiAoYXJyYXkubGVuZ3RoID09PSAwKSB7XG4gICAgYXJyYXkucHVzaCh2YWx1ZSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBjb25zdCBpID0gTG9jYWxDb2xsZWN0aW9uLl9iaW5hcnlTZWFyY2goY21wLCBhcnJheSwgdmFsdWUpO1xuXG4gIGFycmF5LnNwbGljZShpLCAwLCB2YWx1ZSk7XG5cbiAgcmV0dXJuIGk7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2lzTW9kaWZpY2F0aW9uTW9kID0gbW9kID0+IHtcbiAgbGV0IGlzTW9kaWZ5ID0gZmFsc2U7XG4gIGxldCBpc1JlcGxhY2UgPSBmYWxzZTtcblxuICBPYmplY3Qua2V5cyhtb2QpLmZvckVhY2goa2V5ID0+IHtcbiAgICBpZiAoa2V5LnN1YnN0cigwLCAxKSA9PT0gJyQnKSB7XG4gICAgICBpc01vZGlmeSA9IHRydWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIGlzUmVwbGFjZSA9IHRydWU7XG4gICAgfVxuICB9KTtcblxuICBpZiAoaXNNb2RpZnkgJiYgaXNSZXBsYWNlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgJ1VwZGF0ZSBwYXJhbWV0ZXIgY2Fubm90IGhhdmUgYm90aCBtb2RpZmllciBhbmQgbm9uLW1vZGlmaWVyIGZpZWxkcy4nXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBpc01vZGlmeTtcbn07XG5cbi8vIFhYWCBtYXliZSB0aGlzIHNob3VsZCBiZSBFSlNPTi5pc09iamVjdCwgdGhvdWdoIEVKU09OIGRvZXNuJ3Qga25vdyBhYm91dFxuLy8gUmVnRXhwXG4vLyBYWFggbm90ZSB0aGF0IF90eXBlKHVuZGVmaW5lZCkgPT09IDMhISEhXG5Mb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3QgPSB4ID0+IHtcbiAgcmV0dXJuIHggJiYgTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKHgpID09PSAzO1xufTtcblxuLy8gWFhYIG5lZWQgYSBzdHJhdGVneSBmb3IgcGFzc2luZyB0aGUgYmluZGluZyBvZiAkIGludG8gdGhpc1xuLy8gZnVuY3Rpb24sIGZyb20gdGhlIGNvbXBpbGVkIHNlbGVjdG9yXG4vL1xuLy8gbWF5YmUganVzdCB7a2V5LnVwLnRvLmp1c3QuYmVmb3JlLmRvbGxhcnNpZ246IGFycmF5X2luZGV4fVxuLy9cbi8vIFhYWCBhdG9taWNpdHk6IGlmIG9uZSBtb2RpZmljYXRpb24gZmFpbHMsIGRvIHdlIHJvbGwgYmFjayB0aGUgd2hvbGVcbi8vIGNoYW5nZT9cbi8vXG4vLyBvcHRpb25zOlxuLy8gICAtIGlzSW5zZXJ0IGlzIHNldCB3aGVuIF9tb2RpZnkgaXMgYmVpbmcgY2FsbGVkIHRvIGNvbXB1dGUgdGhlIGRvY3VtZW50IHRvXG4vLyAgICAgaW5zZXJ0IGFzIHBhcnQgb2YgYW4gdXBzZXJ0IG9wZXJhdGlvbi4gV2UgdXNlIHRoaXMgcHJpbWFyaWx5IHRvIGZpZ3VyZVxuLy8gICAgIG91dCB3aGVuIHRvIHNldCB0aGUgZmllbGRzIGluICRzZXRPbkluc2VydCwgaWYgcHJlc2VudC5cbkxvY2FsQ29sbGVjdGlvbi5fbW9kaWZ5ID0gKGRvYywgbW9kaWZpZXIsIG9wdGlvbnMgPSB7fSkgPT4ge1xuICBpZiAoIUxvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChtb2RpZmllcikpIHtcbiAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignTW9kaWZpZXIgbXVzdCBiZSBhbiBvYmplY3QnKTtcbiAgfVxuXG4gIC8vIE1ha2Ugc3VyZSB0aGUgY2FsbGVyIGNhbid0IG11dGF0ZSBvdXIgZGF0YSBzdHJ1Y3R1cmVzLlxuICBtb2RpZmllciA9IEVKU09OLmNsb25lKG1vZGlmaWVyKTtcblxuICBjb25zdCBpc01vZGlmaWVyID0gaXNPcGVyYXRvck9iamVjdChtb2RpZmllcik7XG4gIGNvbnN0IG5ld0RvYyA9IGlzTW9kaWZpZXIgPyBFSlNPTi5jbG9uZShkb2MpIDogbW9kaWZpZXI7XG5cbiAgaWYgKGlzTW9kaWZpZXIpIHtcbiAgICAvLyBhcHBseSBtb2RpZmllcnMgdG8gdGhlIGRvYy5cbiAgICBPYmplY3Qua2V5cyhtb2RpZmllcikuZm9yRWFjaChvcGVyYXRvciA9PiB7XG4gICAgICAvLyBUcmVhdCAkc2V0T25JbnNlcnQgYXMgJHNldCBpZiB0aGlzIGlzIGFuIGluc2VydC5cbiAgICAgIGNvbnN0IHNldE9uSW5zZXJ0ID0gb3B0aW9ucy5pc0luc2VydCAmJiBvcGVyYXRvciA9PT0gJyRzZXRPbkluc2VydCc7XG4gICAgICBjb25zdCBtb2RGdW5jID0gTU9ESUZJRVJTW3NldE9uSW5zZXJ0ID8gJyRzZXQnIDogb3BlcmF0b3JdO1xuICAgICAgY29uc3Qgb3BlcmFuZCA9IG1vZGlmaWVyW29wZXJhdG9yXTtcblxuICAgICAgaWYgKCFtb2RGdW5jKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKGBJbnZhbGlkIG1vZGlmaWVyIHNwZWNpZmllZCAke29wZXJhdG9yfWApO1xuICAgICAgfVxuXG4gICAgICBPYmplY3Qua2V5cyhvcGVyYW5kKS5mb3JFYWNoKGtleXBhdGggPT4ge1xuICAgICAgICBjb25zdCBhcmcgPSBvcGVyYW5kW2tleXBhdGhdO1xuXG4gICAgICAgIGlmIChrZXlwYXRoID09PSAnJykge1xuICAgICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdBbiBlbXB0eSB1cGRhdGUgcGF0aCBpcyBub3QgdmFsaWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBrZXlwYXJ0cyA9IGtleXBhdGguc3BsaXQoJy4nKTtcblxuICAgICAgICBpZiAoIWtleXBhcnRzLmV2ZXJ5KEJvb2xlYW4pKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICBgVGhlIHVwZGF0ZSBwYXRoICcke2tleXBhdGh9JyBjb250YWlucyBhbiBlbXB0eSBmaWVsZCBuYW1lLCBgICtcbiAgICAgICAgICAgICd3aGljaCBpcyBub3QgYWxsb3dlZC4nXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGZpbmRNb2RUYXJnZXQobmV3RG9jLCBrZXlwYXJ0cywge1xuICAgICAgICAgIGFycmF5SW5kaWNlczogb3B0aW9ucy5hcnJheUluZGljZXMsXG4gICAgICAgICAgZm9yYmlkQXJyYXk6IG9wZXJhdG9yID09PSAnJHJlbmFtZScsXG4gICAgICAgICAgbm9DcmVhdGU6IE5PX0NSRUFURV9NT0RJRklFUlNbb3BlcmF0b3JdXG4gICAgICAgIH0pO1xuXG4gICAgICAgIG1vZEZ1bmModGFyZ2V0LCBrZXlwYXJ0cy5wb3AoKSwgYXJnLCBrZXlwYXRoLCBuZXdEb2MpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBpZiAoZG9jLl9pZCAmJiAhRUpTT04uZXF1YWxzKGRvYy5faWQsIG5ld0RvYy5faWQpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgYEFmdGVyIGFwcGx5aW5nIHRoZSB1cGRhdGUgdG8gdGhlIGRvY3VtZW50IHtfaWQ6IFwiJHtkb2MuX2lkfVwiLCAuLi59LGAgK1xuICAgICAgICAnIHRoZSAoaW1tdXRhYmxlKSBmaWVsZCBcXCdfaWRcXCcgd2FzIGZvdW5kIHRvIGhhdmUgYmVlbiBhbHRlcmVkIHRvICcgK1xuICAgICAgICBgX2lkOiBcIiR7bmV3RG9jLl9pZH1cImBcbiAgICAgICk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGlmIChkb2MuX2lkICYmIG1vZGlmaWVyLl9pZCAmJiAhRUpTT04uZXF1YWxzKGRvYy5faWQsIG1vZGlmaWVyLl9pZCkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICBgVGhlIF9pZCBmaWVsZCBjYW5ub3QgYmUgY2hhbmdlZCBmcm9tIHtfaWQ6IFwiJHtkb2MuX2lkfVwifSB0byBgICtcbiAgICAgICAgYHtfaWQ6IFwiJHttb2RpZmllci5faWR9XCJ9YFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyByZXBsYWNlIHRoZSB3aG9sZSBkb2N1bWVudFxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyhtb2RpZmllcik7XG4gIH1cblxuICAvLyBtb3ZlIG5ldyBkb2N1bWVudCBpbnRvIHBsYWNlLlxuICBPYmplY3Qua2V5cyhkb2MpLmZvckVhY2goa2V5ID0+IHtcbiAgICAvLyBOb3RlOiB0aGlzIHVzZWQgdG8gYmUgZm9yICh2YXIga2V5IGluIGRvYykgaG93ZXZlciwgdGhpcyBkb2VzIG5vdFxuICAgIC8vIHdvcmsgcmlnaHQgaW4gT3BlcmEuIERlbGV0aW5nIGZyb20gYSBkb2Mgd2hpbGUgaXRlcmF0aW5nIG92ZXIgaXRcbiAgICAvLyB3b3VsZCBzb21ldGltZXMgY2F1c2Ugb3BlcmEgdG8gc2tpcCBzb21lIGtleXMuXG4gICAgaWYgKGtleSAhPT0gJ19pZCcpIHtcbiAgICAgIGRlbGV0ZSBkb2Nba2V5XTtcbiAgICB9XG4gIH0pO1xuXG4gIE9iamVjdC5rZXlzKG5ld0RvYykuZm9yRWFjaChrZXkgPT4ge1xuICAgIGRvY1trZXldID0gbmV3RG9jW2tleV07XG4gIH0pO1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9vYnNlcnZlRnJvbU9ic2VydmVDaGFuZ2VzID0gKGN1cnNvciwgb2JzZXJ2ZUNhbGxiYWNrcykgPT4ge1xuICBjb25zdCB0cmFuc2Zvcm0gPSBjdXJzb3IuZ2V0VHJhbnNmb3JtKCkgfHwgKGRvYyA9PiBkb2MpO1xuICBsZXQgc3VwcHJlc3NlZCA9ICEhb2JzZXJ2ZUNhbGxiYWNrcy5fc3VwcHJlc3NfaW5pdGlhbDtcblxuICBsZXQgb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3M7XG4gIGlmIChMb2NhbENvbGxlY3Rpb24uX29ic2VydmVDYWxsYmFja3NBcmVPcmRlcmVkKG9ic2VydmVDYWxsYmFja3MpKSB7XG4gICAgLy8gVGhlIFwiX25vX2luZGljZXNcIiBvcHRpb24gc2V0cyBhbGwgaW5kZXggYXJndW1lbnRzIHRvIC0xIGFuZCBza2lwcyB0aGVcbiAgICAvLyBsaW5lYXIgc2NhbnMgcmVxdWlyZWQgdG8gZ2VuZXJhdGUgdGhlbS4gIFRoaXMgbGV0cyBvYnNlcnZlcnMgdGhhdCBkb24ndFxuICAgIC8vIG5lZWQgYWJzb2x1dGUgaW5kaWNlcyBiZW5lZml0IGZyb20gdGhlIG90aGVyIGZlYXR1cmVzIG9mIHRoaXMgQVBJIC0tXG4gICAgLy8gcmVsYXRpdmUgb3JkZXIsIHRyYW5zZm9ybXMsIGFuZCBhcHBseUNoYW5nZXMgLS0gd2l0aG91dCB0aGUgc3BlZWQgaGl0LlxuICAgIGNvbnN0IGluZGljZXMgPSAhb2JzZXJ2ZUNhbGxiYWNrcy5fbm9faW5kaWNlcztcblxuICAgIG9ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzID0ge1xuICAgICAgYWRkZWRCZWZvcmUoaWQsIGZpZWxkcywgYmVmb3JlKSB7XG4gICAgICAgIGlmIChzdXBwcmVzc2VkIHx8ICEob2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZEF0IHx8IG9ic2VydmVDYWxsYmFja3MuYWRkZWQpKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZG9jID0gdHJhbnNmb3JtKE9iamVjdC5hc3NpZ24oZmllbGRzLCB7X2lkOiBpZH0pKTtcblxuICAgICAgICBpZiAob2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZEF0KSB7XG4gICAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZEF0KFxuICAgICAgICAgICAgZG9jLFxuICAgICAgICAgICAgaW5kaWNlc1xuICAgICAgICAgICAgICA/IGJlZm9yZVxuICAgICAgICAgICAgICAgID8gdGhpcy5kb2NzLmluZGV4T2YoYmVmb3JlKVxuICAgICAgICAgICAgICAgIDogdGhpcy5kb2NzLnNpemUoKVxuICAgICAgICAgICAgICA6IC0xLFxuICAgICAgICAgICAgYmVmb3JlXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkKGRvYyk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjaGFuZ2VkKGlkLCBmaWVsZHMpIHtcbiAgICAgICAgaWYgKCEob2JzZXJ2ZUNhbGxiYWNrcy5jaGFuZ2VkQXQgfHwgb2JzZXJ2ZUNhbGxiYWNrcy5jaGFuZ2VkKSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkb2MgPSBFSlNPTi5jbG9uZSh0aGlzLmRvY3MuZ2V0KGlkKSk7XG4gICAgICAgIGlmICghZG9jKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGlkIGZvciBjaGFuZ2VkOiAke2lkfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgb2xkRG9jID0gdHJhbnNmb3JtKEVKU09OLmNsb25lKGRvYykpO1xuXG4gICAgICAgIERpZmZTZXF1ZW5jZS5hcHBseUNoYW5nZXMoZG9jLCBmaWVsZHMpO1xuXG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWRBdCkge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZEF0KFxuICAgICAgICAgICAgdHJhbnNmb3JtKGRvYyksXG4gICAgICAgICAgICBvbGREb2MsXG4gICAgICAgICAgICBpbmRpY2VzID8gdGhpcy5kb2NzLmluZGV4T2YoaWQpIDogLTFcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZCh0cmFuc2Zvcm0oZG9jKSwgb2xkRG9jKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIG1vdmVkQmVmb3JlKGlkLCBiZWZvcmUpIHtcbiAgICAgICAgaWYgKCFvYnNlcnZlQ2FsbGJhY2tzLm1vdmVkVG8pIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBmcm9tID0gaW5kaWNlcyA/IHRoaXMuZG9jcy5pbmRleE9mKGlkKSA6IC0xO1xuICAgICAgICBsZXQgdG8gPSBpbmRpY2VzXG4gICAgICAgICAgPyBiZWZvcmVcbiAgICAgICAgICAgID8gdGhpcy5kb2NzLmluZGV4T2YoYmVmb3JlKVxuICAgICAgICAgICAgOiB0aGlzLmRvY3Muc2l6ZSgpXG4gICAgICAgICAgOiAtMTtcblxuICAgICAgICAvLyBXaGVuIG5vdCBtb3ZpbmcgYmFja3dhcmRzLCBhZGp1c3QgZm9yIHRoZSBmYWN0IHRoYXQgcmVtb3ZpbmcgdGhlXG4gICAgICAgIC8vIGRvY3VtZW50IHNsaWRlcyBldmVyeXRoaW5nIGJhY2sgb25lIHNsb3QuXG4gICAgICAgIGlmICh0byA+IGZyb20pIHtcbiAgICAgICAgICAtLXRvO1xuICAgICAgICB9XG5cbiAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5tb3ZlZFRvKFxuICAgICAgICAgIHRyYW5zZm9ybShFSlNPTi5jbG9uZSh0aGlzLmRvY3MuZ2V0KGlkKSkpLFxuICAgICAgICAgIGZyb20sXG4gICAgICAgICAgdG8sXG4gICAgICAgICAgYmVmb3JlIHx8IG51bGxcbiAgICAgICAgKTtcbiAgICAgIH0sXG4gICAgICByZW1vdmVkKGlkKSB7XG4gICAgICAgIGlmICghKG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZEF0IHx8IG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZCkpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICAvLyB0ZWNobmljYWxseSBtYXliZSB0aGVyZSBzaG91bGQgYmUgYW4gRUpTT04uY2xvbmUgaGVyZSwgYnV0IGl0J3MgYWJvdXRcbiAgICAgICAgLy8gdG8gYmUgcmVtb3ZlZCBmcm9tIHRoaXMuZG9jcyFcbiAgICAgICAgY29uc3QgZG9jID0gdHJhbnNmb3JtKHRoaXMuZG9jcy5nZXQoaWQpKTtcblxuICAgICAgICBpZiAob2JzZXJ2ZUNhbGxiYWNrcy5yZW1vdmVkQXQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWRBdChkb2MsIGluZGljZXMgPyB0aGlzLmRvY3MuaW5kZXhPZihpZCkgOiAtMSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5yZW1vdmVkKGRvYyk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfTtcbiAgfSBlbHNlIHtcbiAgICBvYnNlcnZlQ2hhbmdlc0NhbGxiYWNrcyA9IHtcbiAgICAgIGFkZGVkKGlkLCBmaWVsZHMpIHtcbiAgICAgICAgaWYgKCFzdXBwcmVzc2VkICYmIG9ic2VydmVDYWxsYmFja3MuYWRkZWQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkKHRyYW5zZm9ybShPYmplY3QuYXNzaWduKGZpZWxkcywge19pZDogaWR9KSkpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgY2hhbmdlZChpZCwgZmllbGRzKSB7XG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWQpIHtcbiAgICAgICAgICBjb25zdCBvbGREb2MgPSB0aGlzLmRvY3MuZ2V0KGlkKTtcbiAgICAgICAgICBjb25zdCBkb2MgPSBFSlNPTi5jbG9uZShvbGREb2MpO1xuXG4gICAgICAgICAgRGlmZlNlcXVlbmNlLmFwcGx5Q2hhbmdlcyhkb2MsIGZpZWxkcyk7XG5cbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWQoXG4gICAgICAgICAgICB0cmFuc2Zvcm0oZG9jKSxcbiAgICAgICAgICAgIHRyYW5zZm9ybShFSlNPTi5jbG9uZShvbGREb2MpKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICByZW1vdmVkKGlkKSB7XG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWQodHJhbnNmb3JtKHRoaXMuZG9jcy5nZXQoaWQpKSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNoYW5nZU9ic2VydmVyID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fQ2FjaGluZ0NoYW5nZU9ic2VydmVyKHtcbiAgICBjYWxsYmFja3M6IG9ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzXG4gIH0pO1xuXG4gIC8vIENhY2hpbmdDaGFuZ2VPYnNlcnZlciBjbG9uZXMgYWxsIHJlY2VpdmVkIGlucHV0IG9uIGl0cyBjYWxsYmFja3NcbiAgLy8gU28gd2UgY2FuIG1hcmsgaXQgYXMgc2FmZSB0byByZWR1Y2UgdGhlIGVqc29uIGNsb25lcy5cbiAgLy8gVGhpcyBpcyB0ZXN0ZWQgYnkgdGhlIGBtb25nby1saXZlZGF0YSAtIChleHRlbmRlZCkgc2NyaWJibGluZ2AgdGVzdHNcbiAgY2hhbmdlT2JzZXJ2ZXIuYXBwbHlDaGFuZ2UuX2Zyb21PYnNlcnZlID0gdHJ1ZTtcbiAgY29uc3QgaGFuZGxlID0gY3Vyc29yLm9ic2VydmVDaGFuZ2VzKGNoYW5nZU9ic2VydmVyLmFwcGx5Q2hhbmdlLFxuICAgIHsgbm9uTXV0YXRpbmdDYWxsYmFja3M6IHRydWUgfSk7XG5cbiAgc3VwcHJlc3NlZCA9IGZhbHNlO1xuXG4gIHJldHVybiBoYW5kbGU7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX29ic2VydmVDYWxsYmFja3NBcmVPcmRlcmVkID0gY2FsbGJhY2tzID0+IHtcbiAgaWYgKGNhbGxiYWNrcy5hZGRlZCAmJiBjYWxsYmFja3MuYWRkZWRBdCkge1xuICAgIHRocm93IG5ldyBFcnJvcignUGxlYXNlIHNwZWNpZnkgb25seSBvbmUgb2YgYWRkZWQoKSBhbmQgYWRkZWRBdCgpJyk7XG4gIH1cblxuICBpZiAoY2FsbGJhY2tzLmNoYW5nZWQgJiYgY2FsbGJhY2tzLmNoYW5nZWRBdCkge1xuICAgIHRocm93IG5ldyBFcnJvcignUGxlYXNlIHNwZWNpZnkgb25seSBvbmUgb2YgY2hhbmdlZCgpIGFuZCBjaGFuZ2VkQXQoKScpO1xuICB9XG5cbiAgaWYgKGNhbGxiYWNrcy5yZW1vdmVkICYmIGNhbGxiYWNrcy5yZW1vdmVkQXQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1BsZWFzZSBzcGVjaWZ5IG9ubHkgb25lIG9mIHJlbW92ZWQoKSBhbmQgcmVtb3ZlZEF0KCknKTtcbiAgfVxuXG4gIHJldHVybiAhIShcbiAgICBjYWxsYmFja3MuYWRkZWRBdCB8fFxuICAgIGNhbGxiYWNrcy5jaGFuZ2VkQXQgfHxcbiAgICBjYWxsYmFja3MubW92ZWRUbyB8fFxuICAgIGNhbGxiYWNrcy5yZW1vdmVkQXRcbiAgKTtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NBcmVPcmRlcmVkID0gY2FsbGJhY2tzID0+IHtcbiAgaWYgKGNhbGxiYWNrcy5hZGRlZCAmJiBjYWxsYmFja3MuYWRkZWRCZWZvcmUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1BsZWFzZSBzcGVjaWZ5IG9ubHkgb25lIG9mIGFkZGVkKCkgYW5kIGFkZGVkQmVmb3JlKCknKTtcbiAgfVxuXG4gIHJldHVybiAhIShjYWxsYmFja3MuYWRkZWRCZWZvcmUgfHwgY2FsbGJhY2tzLm1vdmVkQmVmb3JlKTtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fcmVtb3ZlRnJvbVJlc3VsdHMgPSAocXVlcnksIGRvYykgPT4ge1xuICBpZiAocXVlcnkub3JkZXJlZCkge1xuICAgIGNvbnN0IGkgPSBMb2NhbENvbGxlY3Rpb24uX2ZpbmRJbk9yZGVyZWRSZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuXG4gICAgcXVlcnkucmVtb3ZlZChkb2MuX2lkKTtcbiAgICBxdWVyeS5yZXN1bHRzLnNwbGljZShpLCAxKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpZCA9IGRvYy5faWQ7ICAvLyBpbiBjYXNlIGNhbGxiYWNrIG11dGF0ZXMgZG9jXG5cbiAgICBxdWVyeS5yZW1vdmVkKGRvYy5faWQpO1xuICAgIHF1ZXJ5LnJlc3VsdHMucmVtb3ZlKGlkKTtcbiAgfVxufTtcblxuLy8gSXMgdGhpcyBzZWxlY3RvciBqdXN0IHNob3J0aGFuZCBmb3IgbG9va3VwIGJ5IF9pZD9cbkxvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkID0gc2VsZWN0b3IgPT5cbiAgdHlwZW9mIHNlbGVjdG9yID09PSAnbnVtYmVyJyB8fFxuICB0eXBlb2Ygc2VsZWN0b3IgPT09ICdzdHJpbmcnIHx8XG4gIHNlbGVjdG9yIGluc3RhbmNlb2YgTW9uZ29JRC5PYmplY3RJRFxuO1xuXG4vLyBJcyB0aGUgc2VsZWN0b3IganVzdCBsb29rdXAgYnkgX2lkIChzaG9ydGhhbmQgb3Igbm90KT9cbkxvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkUGVyaGFwc0FzT2JqZWN0ID0gc2VsZWN0b3IgPT5cbiAgTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpIHx8XG4gIExvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkKHNlbGVjdG9yICYmIHNlbGVjdG9yLl9pZCkgJiZcbiAgT2JqZWN0LmtleXMoc2VsZWN0b3IpLmxlbmd0aCA9PT0gMVxuO1xuXG5Mb2NhbENvbGxlY3Rpb24uX3VwZGF0ZUluUmVzdWx0cyA9IChxdWVyeSwgZG9jLCBvbGRfZG9jKSA9PiB7XG4gIGlmICghRUpTT04uZXF1YWxzKGRvYy5faWQsIG9sZF9kb2MuX2lkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignQ2FuXFwndCBjaGFuZ2UgYSBkb2NcXCdzIF9pZCB3aGlsZSB1cGRhdGluZycpO1xuICB9XG5cbiAgY29uc3QgcHJvamVjdGlvbkZuID0gcXVlcnkucHJvamVjdGlvbkZuO1xuICBjb25zdCBjaGFuZ2VkRmllbGRzID0gRGlmZlNlcXVlbmNlLm1ha2VDaGFuZ2VkRmllbGRzKFxuICAgIHByb2plY3Rpb25Gbihkb2MpLFxuICAgIHByb2plY3Rpb25GbihvbGRfZG9jKVxuICApO1xuXG4gIGlmICghcXVlcnkub3JkZXJlZCkge1xuICAgIGlmIChPYmplY3Qua2V5cyhjaGFuZ2VkRmllbGRzKS5sZW5ndGgpIHtcbiAgICAgIHF1ZXJ5LmNoYW5nZWQoZG9jLl9pZCwgY2hhbmdlZEZpZWxkcyk7XG4gICAgICBxdWVyeS5yZXN1bHRzLnNldChkb2MuX2lkLCBkb2MpO1xuICAgIH1cblxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IG9sZF9pZHggPSBMb2NhbENvbGxlY3Rpb24uX2ZpbmRJbk9yZGVyZWRSZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuXG4gIGlmIChPYmplY3Qua2V5cyhjaGFuZ2VkRmllbGRzKS5sZW5ndGgpIHtcbiAgICBxdWVyeS5jaGFuZ2VkKGRvYy5faWQsIGNoYW5nZWRGaWVsZHMpO1xuICB9XG5cbiAgaWYgKCFxdWVyeS5zb3J0ZXIpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBqdXN0IHRha2UgaXQgb3V0IGFuZCBwdXQgaXQgYmFjayBpbiBhZ2FpbiwgYW5kIHNlZSBpZiB0aGUgaW5kZXggY2hhbmdlc1xuICBxdWVyeS5yZXN1bHRzLnNwbGljZShvbGRfaWR4LCAxKTtcblxuICBjb25zdCBuZXdfaWR4ID0gTG9jYWxDb2xsZWN0aW9uLl9pbnNlcnRJblNvcnRlZExpc3QoXG4gICAgcXVlcnkuc29ydGVyLmdldENvbXBhcmF0b3Ioe2Rpc3RhbmNlczogcXVlcnkuZGlzdGFuY2VzfSksXG4gICAgcXVlcnkucmVzdWx0cyxcbiAgICBkb2NcbiAgKTtcblxuICBpZiAob2xkX2lkeCAhPT0gbmV3X2lkeCkge1xuICAgIGxldCBuZXh0ID0gcXVlcnkucmVzdWx0c1tuZXdfaWR4ICsgMV07XG4gICAgaWYgKG5leHQpIHtcbiAgICAgIG5leHQgPSBuZXh0Ll9pZDtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV4dCA9IG51bGw7XG4gICAgfVxuXG4gICAgcXVlcnkubW92ZWRCZWZvcmUgJiYgcXVlcnkubW92ZWRCZWZvcmUoZG9jLl9pZCwgbmV4dCk7XG4gIH1cbn07XG5cbmNvbnN0IE1PRElGSUVSUyA9IHtcbiAgJGN1cnJlbnREYXRlKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBoYXNPd24uY2FsbChhcmcsICckdHlwZScpKSB7XG4gICAgICBpZiAoYXJnLiR0eXBlICE9PSAnZGF0ZScpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ01pbmltb25nbyBkb2VzIGN1cnJlbnRseSBvbmx5IHN1cHBvcnQgdGhlIGRhdGUgdHlwZSBpbiAnICtcbiAgICAgICAgICAnJGN1cnJlbnREYXRlIG1vZGlmaWVycycsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoYXJnICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignSW52YWxpZCAkY3VycmVudERhdGUgbW9kaWZpZXInLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICB0YXJnZXRbZmllbGRdID0gbmV3IERhdGUoKTtcbiAgfSxcbiAgJGluYyh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkaW5jIGFsbG93ZWQgZm9yIG51bWJlcnMgb25seScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmIChmaWVsZCBpbiB0YXJnZXQpIHtcbiAgICAgIGlmICh0eXBlb2YgdGFyZ2V0W2ZpZWxkXSAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ0Nhbm5vdCBhcHBseSAkaW5jIG1vZGlmaWVyIHRvIG5vbi1udW1iZXInLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgdGFyZ2V0W2ZpZWxkXSArPSBhcmc7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gICAgfVxuICB9LFxuICAkbWluKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0eXBlb2YgYXJnICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ01vZGlmaWVyICRtaW4gYWxsb3dlZCBmb3IgbnVtYmVycyBvbmx5Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkIGluIHRhcmdldCkge1xuICAgICAgaWYgKHR5cGVvZiB0YXJnZXRbZmllbGRdICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAnQ2Fubm90IGFwcGx5ICRtaW4gbW9kaWZpZXIgdG8gbm9uLW51bWJlcicsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAodGFyZ2V0W2ZpZWxkXSA+IGFyZykge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgIH1cbiAgfSxcbiAgJG1heCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkbWF4IGFsbG93ZWQgZm9yIG51bWJlcnMgb25seScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmIChmaWVsZCBpbiB0YXJnZXQpIHtcbiAgICAgIGlmICh0eXBlb2YgdGFyZ2V0W2ZpZWxkXSAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ0Nhbm5vdCBhcHBseSAkbWF4IG1vZGlmaWVyIHRvIG5vbi1udW1iZXInLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHRhcmdldFtmaWVsZF0gPCBhcmcpIHtcbiAgICAgICAgdGFyZ2V0W2ZpZWxkXSA9IGFyZztcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGFyZ2V0W2ZpZWxkXSA9IGFyZztcbiAgICB9XG4gIH0sXG4gICRtdWwodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHR5cGVvZiBhcmcgIT09ICdudW1iZXInKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignTW9kaWZpZXIgJG11bCBhbGxvd2VkIGZvciBudW1iZXJzIG9ubHknLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGQgaW4gdGFyZ2V0KSB7XG4gICAgICBpZiAodHlwZW9mIHRhcmdldFtmaWVsZF0gIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgICdDYW5ub3QgYXBwbHkgJG11bCBtb2RpZmllciB0byBub24tbnVtYmVyJyxcbiAgICAgICAgICB7ZmllbGR9XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHRhcmdldFtmaWVsZF0gKj0gYXJnO1xuICAgIH0gZWxzZSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gMDtcbiAgICB9XG4gIH0sXG4gICRyZW5hbWUodGFyZ2V0LCBmaWVsZCwgYXJnLCBrZXlwYXRoLCBkb2MpIHtcbiAgICAvLyBubyBpZGVhIHdoeSBtb25nbyBoYXMgdGhpcyByZXN0cmljdGlvbi4uXG4gICAgaWYgKGtleXBhdGggPT09IGFyZykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRyZW5hbWUgc291cmNlIG11c3QgZGlmZmVyIGZyb20gdGFyZ2V0Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKHRhcmdldCA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRyZW5hbWUgc291cmNlIGZpZWxkIGludmFsaWQnLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ3N0cmluZycpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckcmVuYW1lIHRhcmdldCBtdXN0IGJlIGEgc3RyaW5nJywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKGFyZy5pbmNsdWRlcygnXFwwJykpIHtcbiAgICAgIC8vIE51bGwgYnl0ZXMgYXJlIG5vdCBhbGxvd2VkIGluIE1vbmdvIGZpZWxkIG5hbWVzXG4gICAgICAvLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9saW1pdHMvI1Jlc3RyaWN0aW9ucy1vbi1GaWVsZC1OYW1lc1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdUaGUgXFwndG9cXCcgZmllbGQgZm9yICRyZW5hbWUgY2Fubm90IGNvbnRhaW4gYW4gZW1iZWRkZWQgbnVsbCBieXRlJyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodGFyZ2V0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBvYmplY3QgPSB0YXJnZXRbZmllbGRdO1xuXG4gICAgZGVsZXRlIHRhcmdldFtmaWVsZF07XG5cbiAgICBjb25zdCBrZXlwYXJ0cyA9IGFyZy5zcGxpdCgnLicpO1xuICAgIGNvbnN0IHRhcmdldDIgPSBmaW5kTW9kVGFyZ2V0KGRvYywga2V5cGFydHMsIHtmb3JiaWRBcnJheTogdHJ1ZX0pO1xuXG4gICAgaWYgKHRhcmdldDIgPT09IG51bGwpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckcmVuYW1lIHRhcmdldCBmaWVsZCBpbnZhbGlkJywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgdGFyZ2V0MltrZXlwYXJ0cy5wb3AoKV0gPSBvYmplY3Q7XG4gIH0sXG4gICRzZXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldCAhPT0gT2JqZWN0KHRhcmdldCkpIHsgLy8gbm90IGFuIGFycmF5IG9yIGFuIG9iamVjdFxuICAgICAgY29uc3QgZXJyb3IgPSBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBzZXQgcHJvcGVydHkgb24gbm9uLW9iamVjdCBmaWVsZCcsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgICBlcnJvci5zZXRQcm9wZXJ0eUVycm9yID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGlmICh0YXJnZXQgPT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGVycm9yID0gTWluaW1vbmdvRXJyb3IoJ0Nhbm5vdCBzZXQgcHJvcGVydHkgb24gbnVsbCcsIHtmaWVsZH0pO1xuICAgICAgZXJyb3Iuc2V0UHJvcGVydHlFcnJvciA9IHRydWU7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG5cbiAgICBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXMoYXJnKTtcblxuICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gIH0sXG4gICRzZXRPbkluc2VydCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICAvLyBjb252ZXJ0ZWQgdG8gYCRzZXRgIGluIGBfbW9kaWZ5YFxuICB9LFxuICAkdW5zZXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAodGFyZ2V0IGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgICAgaWYgKGZpZWxkIGluIHRhcmdldCkge1xuICAgICAgICAgIHRhcmdldFtmaWVsZF0gPSBudWxsO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWxldGUgdGFyZ2V0W2ZpZWxkXTtcbiAgICAgIH1cbiAgICB9XG4gIH0sXG4gICRwdXNoKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0YXJnZXRbZmllbGRdID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSBbXTtcbiAgICB9XG5cbiAgICBpZiAoISh0YXJnZXRbZmllbGRdIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignQ2Fubm90IGFwcGx5ICRwdXNoIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmICghKGFyZyAmJiBhcmcuJGVhY2gpKSB7XG4gICAgICAvLyBTaW1wbGUgbW9kZTogbm90ICRlYWNoXG4gICAgICBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXMoYXJnKTtcblxuICAgICAgdGFyZ2V0W2ZpZWxkXS5wdXNoKGFyZyk7XG5cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBGYW5jeSBtb2RlOiAkZWFjaCAoYW5kIG1heWJlICRzbGljZSBhbmQgJHNvcnQgYW5kICRwb3NpdGlvbilcbiAgICBjb25zdCB0b1B1c2ggPSBhcmcuJGVhY2g7XG4gICAgaWYgKCEodG9QdXNoIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJGVhY2ggbXVzdCBiZSBhbiBhcnJheScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyh0b1B1c2gpO1xuXG4gICAgLy8gUGFyc2UgJHBvc2l0aW9uXG4gICAgbGV0IHBvc2l0aW9uID0gdW5kZWZpbmVkO1xuICAgIGlmICgnJHBvc2l0aW9uJyBpbiBhcmcpIHtcbiAgICAgIGlmICh0eXBlb2YgYXJnLiRwb3NpdGlvbiAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRwb3NpdGlvbiBtdXN0IGJlIGEgbnVtZXJpYyB2YWx1ZScsIHtmaWVsZH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggc2hvdWxkIGNoZWNrIHRvIG1ha2Ugc3VyZSBpbnRlZ2VyXG4gICAgICBpZiAoYXJnLiRwb3NpdGlvbiA8IDApIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJyRwb3NpdGlvbiBpbiAkcHVzaCBtdXN0IGJlIHplcm8gb3IgcG9zaXRpdmUnLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgcG9zaXRpb24gPSBhcmcuJHBvc2l0aW9uO1xuICAgIH1cblxuICAgIC8vIFBhcnNlICRzbGljZS5cbiAgICBsZXQgc2xpY2UgPSB1bmRlZmluZWQ7XG4gICAgaWYgKCckc2xpY2UnIGluIGFyZykge1xuICAgICAgaWYgKHR5cGVvZiBhcmcuJHNsaWNlICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJHNsaWNlIG11c3QgYmUgYSBudW1lcmljIHZhbHVlJywge2ZpZWxkfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIFhYWCBzaG91bGQgY2hlY2sgdG8gbWFrZSBzdXJlIGludGVnZXJcbiAgICAgIHNsaWNlID0gYXJnLiRzbGljZTtcbiAgICB9XG5cbiAgICAvLyBQYXJzZSAkc29ydC5cbiAgICBsZXQgc29ydEZ1bmN0aW9uID0gdW5kZWZpbmVkO1xuICAgIGlmIChhcmcuJHNvcnQpIHtcbiAgICAgIGlmIChzbGljZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckc29ydCByZXF1aXJlcyAkc2xpY2UgdG8gYmUgcHJlc2VudCcsIHtmaWVsZH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggdGhpcyBhbGxvd3MgdXMgdG8gdXNlIGEgJHNvcnQgd2hvc2UgdmFsdWUgaXMgYW4gYXJyYXksIGJ1dCB0aGF0J3NcbiAgICAgIC8vIGFjdHVhbGx5IGFuIGV4dGVuc2lvbiBvZiB0aGUgTm9kZSBkcml2ZXIsIHNvIGl0IHdvbid0IHdvcmtcbiAgICAgIC8vIHNlcnZlci1zaWRlLiBDb3VsZCBiZSBjb25mdXNpbmchXG4gICAgICAvLyBYWFggaXMgaXQgY29ycmVjdCB0aGF0IHdlIGRvbid0IGRvIGdlby1zdHVmZiBoZXJlP1xuICAgICAgc29ydEZ1bmN0aW9uID0gbmV3IE1pbmltb25nby5Tb3J0ZXIoYXJnLiRzb3J0KS5nZXRDb21wYXJhdG9yKCk7XG5cbiAgICAgIHRvUHVzaC5mb3JFYWNoKGVsZW1lbnQgPT4ge1xuICAgICAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKGVsZW1lbnQpICE9PSAzKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICAnJHB1c2ggbGlrZSBtb2RpZmllcnMgdXNpbmcgJHNvcnQgcmVxdWlyZSBhbGwgZWxlbWVudHMgdG8gYmUgJyArXG4gICAgICAgICAgICAnb2JqZWN0cycsXG4gICAgICAgICAgICB7ZmllbGR9XG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQWN0dWFsbHkgcHVzaC5cbiAgICBpZiAocG9zaXRpb24gPT09IHVuZGVmaW5lZCkge1xuICAgICAgdG9QdXNoLmZvckVhY2goZWxlbWVudCA9PiB7XG4gICAgICAgIHRhcmdldFtmaWVsZF0ucHVzaChlbGVtZW50KTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzcGxpY2VBcmd1bWVudHMgPSBbcG9zaXRpb24sIDBdO1xuXG4gICAgICB0b1B1c2guZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgc3BsaWNlQXJndW1lbnRzLnB1c2goZWxlbWVudCk7XG4gICAgICB9KTtcblxuICAgICAgdGFyZ2V0W2ZpZWxkXS5zcGxpY2UoLi4uc3BsaWNlQXJndW1lbnRzKTtcbiAgICB9XG5cbiAgICAvLyBBY3R1YWxseSBzb3J0LlxuICAgIGlmIChzb3J0RnVuY3Rpb24pIHtcbiAgICAgIHRhcmdldFtmaWVsZF0uc29ydChzb3J0RnVuY3Rpb24pO1xuICAgIH1cblxuICAgIC8vIEFjdHVhbGx5IHNsaWNlLlxuICAgIGlmIChzbGljZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoc2xpY2UgPT09IDApIHtcbiAgICAgICAgdGFyZ2V0W2ZpZWxkXSA9IFtdOyAvLyBkaWZmZXJzIGZyb20gQXJyYXkuc2xpY2UhXG4gICAgICB9IGVsc2UgaWYgKHNsaWNlIDwgMCkge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gdGFyZ2V0W2ZpZWxkXS5zbGljZShzbGljZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gdGFyZ2V0W2ZpZWxkXS5zbGljZSgwLCBzbGljZSk7XG4gICAgICB9XG4gICAgfVxuICB9LFxuICAkcHVzaEFsbCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAoISh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkcHVzaEFsbC9wdWxsQWxsIGFsbG93ZWQgZm9yIGFycmF5cyBvbmx5Jyk7XG4gICAgfVxuXG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKGFyZyk7XG5cbiAgICBjb25zdCB0b1B1c2ggPSB0YXJnZXRbZmllbGRdO1xuXG4gICAgaWYgKHRvUHVzaCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgIH0gZWxzZSBpZiAoISh0b1B1c2ggaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnQ2Fubm90IGFwcGx5ICRwdXNoQWxsIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRvUHVzaC5wdXNoKC4uLmFyZyk7XG4gICAgfVxuICB9LFxuICAkYWRkVG9TZXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgbGV0IGlzRWFjaCA9IGZhbHNlO1xuXG4gICAgaWYgKHR5cGVvZiBhcmcgPT09ICdvYmplY3QnKSB7XG4gICAgICAvLyBjaGVjayBpZiBmaXJzdCBrZXkgaXMgJyRlYWNoJ1xuICAgICAgY29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKGFyZyk7XG4gICAgICBpZiAoa2V5c1swXSA9PT0gJyRlYWNoJykge1xuICAgICAgICBpc0VhY2ggPSB0cnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHZhbHVlcyA9IGlzRWFjaCA/IGFyZy4kZWFjaCA6IFthcmddO1xuXG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKHZhbHVlcyk7XG5cbiAgICBjb25zdCB0b0FkZCA9IHRhcmdldFtmaWVsZF07XG4gICAgaWYgKHRvQWRkID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSB2YWx1ZXM7XG4gICAgfSBlbHNlIGlmICghKHRvQWRkIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBhcHBseSAkYWRkVG9TZXQgbW9kaWZpZXIgdG8gbm9uLWFycmF5JyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmFsdWVzLmZvckVhY2godmFsdWUgPT4ge1xuICAgICAgICBpZiAodG9BZGQuc29tZShlbGVtZW50ID0+IExvY2FsQ29sbGVjdGlvbi5fZi5fZXF1YWwodmFsdWUsIGVsZW1lbnQpKSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRvQWRkLnB1c2godmFsdWUpO1xuICAgICAgfSk7XG4gICAgfVxuICB9LFxuICAkcG9wKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0YXJnZXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRvUG9wID0gdGFyZ2V0W2ZpZWxkXTtcblxuICAgIGlmICh0b1BvcCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEodG9Qb3AgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdDYW5ub3QgYXBwbHkgJHBvcCBtb2RpZmllciB0byBub24tYXJyYXknLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGFyZyA9PT0gJ251bWJlcicgJiYgYXJnIDwgMCkge1xuICAgICAgdG9Qb3Auc3BsaWNlKDAsIDEpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0b1BvcC5wb3AoKTtcbiAgICB9XG4gIH0sXG4gICRwdWxsKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0YXJnZXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRvUHVsbCA9IHRhcmdldFtmaWVsZF07XG4gICAgaWYgKHRvUHVsbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEodG9QdWxsIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBhcHBseSAkcHVsbC9wdWxsQWxsIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgbGV0IG91dDtcbiAgICBpZiAoYXJnICE9IG51bGwgJiYgdHlwZW9mIGFyZyA9PT0gJ29iamVjdCcgJiYgIShhcmcgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIC8vIFhYWCB3b3VsZCBiZSBtdWNoIG5pY2VyIHRvIGNvbXBpbGUgdGhpcyBvbmNlLCByYXRoZXIgdGhhblxuICAgICAgLy8gZm9yIGVhY2ggZG9jdW1lbnQgd2UgbW9kaWZ5Li4gYnV0IHVzdWFsbHkgd2UncmUgbm90XG4gICAgICAvLyBtb2RpZnlpbmcgdGhhdCBtYW55IGRvY3VtZW50cywgc28gd2UnbGwgbGV0IGl0IHNsaWRlIGZvclxuICAgICAgLy8gbm93XG5cbiAgICAgIC8vIFhYWCBNaW5pbW9uZ28uTWF0Y2hlciBpc24ndCB1cCBmb3IgdGhlIGpvYiwgYmVjYXVzZSB3ZSBuZWVkXG4gICAgICAvLyB0byBwZXJtaXQgc3R1ZmYgbGlrZSB7JHB1bGw6IHthOiB7JGd0OiA0fX19Li4gc29tZXRoaW5nXG4gICAgICAvLyBsaWtlIHskZ3Q6IDR9IGlzIG5vdCBub3JtYWxseSBhIGNvbXBsZXRlIHNlbGVjdG9yLlxuICAgICAgLy8gc2FtZSBpc3N1ZSBhcyAkZWxlbU1hdGNoIHBvc3NpYmx5P1xuICAgICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihhcmcpO1xuXG4gICAgICBvdXQgPSB0b1B1bGwuZmlsdGVyKGVsZW1lbnQgPT4gIW1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGVsZW1lbnQpLnJlc3VsdCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG91dCA9IHRvUHVsbC5maWx0ZXIoZWxlbWVudCA9PiAhTG9jYWxDb2xsZWN0aW9uLl9mLl9lcXVhbChlbGVtZW50LCBhcmcpKTtcbiAgICB9XG5cbiAgICB0YXJnZXRbZmllbGRdID0gb3V0O1xuICB9LFxuICAkcHVsbEFsbCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAoISh0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiBhcmcgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnTW9kaWZpZXIgJHB1c2hBbGwvcHVsbEFsbCBhbGxvd2VkIGZvciBhcnJheXMgb25seScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKHRhcmdldCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdG9QdWxsID0gdGFyZ2V0W2ZpZWxkXTtcblxuICAgIGlmICh0b1B1bGwgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghKHRvUHVsbCBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdDYW5ub3QgYXBwbHkgJHB1bGwvcHVsbEFsbCBtb2RpZmllciB0byBub24tYXJyYXknLFxuICAgICAgICB7ZmllbGR9XG4gICAgICApO1xuICAgIH1cblxuICAgIHRhcmdldFtmaWVsZF0gPSB0b1B1bGwuZmlsdGVyKG9iamVjdCA9PlxuICAgICAgIWFyZy5zb21lKGVsZW1lbnQgPT4gTG9jYWxDb2xsZWN0aW9uLl9mLl9lcXVhbChvYmplY3QsIGVsZW1lbnQpKVxuICAgICk7XG4gIH0sXG4gICRiaXQodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgLy8gWFhYIG1vbmdvIG9ubHkgc3VwcG9ydHMgJGJpdCBvbiBpbnRlZ2VycywgYW5kIHdlIG9ubHkgc3VwcG9ydFxuICAgIC8vIG5hdGl2ZSBqYXZhc2NyaXB0IG51bWJlcnMgKGRvdWJsZXMpIHNvIGZhciwgc28gd2UgY2FuJ3Qgc3VwcG9ydCAkYml0XG4gICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRiaXQgaXMgbm90IHN1cHBvcnRlZCcsIHtmaWVsZH0pO1xuICB9LFxuICAkdigpIHtcbiAgICAvLyBBcyBkaXNjdXNzZWQgaW4gaHR0cHM6Ly9naXRodWIuY29tL21ldGVvci9tZXRlb3IvaXNzdWVzLzk2MjMsXG4gICAgLy8gdGhlIGAkdmAgb3BlcmF0b3IgaXMgbm90IG5lZWRlZCBieSBNZXRlb3IsIGJ1dCBwcm9ibGVtcyBjYW4gb2NjdXIgaWZcbiAgICAvLyBpdCdzIG5vdCBhdCBsZWFzdCBjYWxsYWJsZSAoYXMgb2YgTW9uZ28gPj0gMy42KS4gSXQncyBkZWZpbmVkIGhlcmUgYXNcbiAgICAvLyBhIG5vLW9wIHRvIHdvcmsgYXJvdW5kIHRoZXNlIHByb2JsZW1zLlxuICB9XG59O1xuXG5jb25zdCBOT19DUkVBVEVfTU9ESUZJRVJTID0ge1xuICAkcG9wOiB0cnVlLFxuICAkcHVsbDogdHJ1ZSxcbiAgJHB1bGxBbGw6IHRydWUsXG4gICRyZW5hbWU6IHRydWUsXG4gICR1bnNldDogdHJ1ZVxufTtcblxuLy8gTWFrZSBzdXJlIGZpZWxkIG5hbWVzIGRvIG5vdCBjb250YWluIE1vbmdvIHJlc3RyaWN0ZWRcbi8vIGNoYXJhY3RlcnMgKCcuJywgJyQnLCAnXFwwJykuXG4vLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9saW1pdHMvI1Jlc3RyaWN0aW9ucy1vbi1GaWVsZC1OYW1lc1xuY29uc3QgaW52YWxpZENoYXJNc2cgPSB7XG4gICQ6ICdzdGFydCB3aXRoIFxcJyRcXCcnLFxuICAnLic6ICdjb250YWluIFxcJy5cXCcnLFxuICAnXFwwJzogJ2NvbnRhaW4gbnVsbCBieXRlcydcbn07XG5cbi8vIGNoZWNrcyBpZiBhbGwgZmllbGQgbmFtZXMgaW4gYW4gb2JqZWN0IGFyZSB2YWxpZFxuZnVuY3Rpb24gYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKGRvYykge1xuICBpZiAoZG9jICYmIHR5cGVvZiBkb2MgPT09ICdvYmplY3QnKSB7XG4gICAgSlNPTi5zdHJpbmdpZnkoZG9jLCAoa2V5LCB2YWx1ZSkgPT4ge1xuICAgICAgYXNzZXJ0SXNWYWxpZEZpZWxkTmFtZShrZXkpO1xuICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFzc2VydElzVmFsaWRGaWVsZE5hbWUoa2V5KSB7XG4gIGxldCBtYXRjaDtcbiAgaWYgKHR5cGVvZiBrZXkgPT09ICdzdHJpbmcnICYmIChtYXRjaCA9IGtleS5tYXRjaCgvXlxcJHxcXC58XFwwLykpKSB7XG4gICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoYEtleSAke2tleX0gbXVzdCBub3QgJHtpbnZhbGlkQ2hhck1zZ1ttYXRjaFswXV19YCk7XG4gIH1cbn1cblxuLy8gZm9yIGEuYi5jLjIuZC5lLCBrZXlwYXJ0cyBzaG91bGQgYmUgWydhJywgJ2InLCAnYycsICcyJywgJ2QnLCAnZSddLFxuLy8gYW5kIHRoZW4geW91IHdvdWxkIG9wZXJhdGUgb24gdGhlICdlJyBwcm9wZXJ0eSBvZiB0aGUgcmV0dXJuZWRcbi8vIG9iamVjdC5cbi8vXG4vLyBpZiBvcHRpb25zLm5vQ3JlYXRlIGlzIGZhbHNleSwgY3JlYXRlcyBpbnRlcm1lZGlhdGUgbGV2ZWxzIG9mXG4vLyBzdHJ1Y3R1cmUgYXMgbmVjZXNzYXJ5LCBsaWtlIG1rZGlyIC1wIChhbmQgcmFpc2VzIGFuIGV4Y2VwdGlvbiBpZlxuLy8gdGhhdCB3b3VsZCBtZWFuIGdpdmluZyBhIG5vbi1udW1lcmljIHByb3BlcnR5IHRvIGFuIGFycmF5LikgaWZcbi8vIG9wdGlvbnMubm9DcmVhdGUgaXMgdHJ1ZSwgcmV0dXJuIHVuZGVmaW5lZCBpbnN0ZWFkLlxuLy9cbi8vIG1heSBtb2RpZnkgdGhlIGxhc3QgZWxlbWVudCBvZiBrZXlwYXJ0cyB0byBzaWduYWwgdG8gdGhlIGNhbGxlciB0aGF0IGl0IG5lZWRzXG4vLyB0byB1c2UgYSBkaWZmZXJlbnQgdmFsdWUgdG8gaW5kZXggaW50byB0aGUgcmV0dXJuZWQgb2JqZWN0IChmb3IgZXhhbXBsZSxcbi8vIFsnYScsICcwMSddIC0+IFsnYScsIDFdKS5cbi8vXG4vLyBpZiBmb3JiaWRBcnJheSBpcyB0cnVlLCByZXR1cm4gbnVsbCBpZiB0aGUga2V5cGF0aCBnb2VzIHRocm91Z2ggYW4gYXJyYXkuXG4vL1xuLy8gaWYgb3B0aW9ucy5hcnJheUluZGljZXMgaXMgc2V0LCB1c2UgaXRzIGZpcnN0IGVsZW1lbnQgZm9yIHRoZSAoZmlyc3QpICckJyBpblxuLy8gdGhlIHBhdGguXG5mdW5jdGlvbiBmaW5kTW9kVGFyZ2V0KGRvYywga2V5cGFydHMsIG9wdGlvbnMgPSB7fSkge1xuICBsZXQgdXNlZEFycmF5SW5kZXggPSBmYWxzZTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGtleXBhcnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGFzdCA9IGkgPT09IGtleXBhcnRzLmxlbmd0aCAtIDE7XG4gICAgbGV0IGtleXBhcnQgPSBrZXlwYXJ0c1tpXTtcblxuICAgIGlmICghaXNJbmRleGFibGUoZG9jKSkge1xuICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUpIHtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZXJyb3IgPSBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgYGNhbm5vdCB1c2UgdGhlIHBhcnQgJyR7a2V5cGFydH0nIHRvIHRyYXZlcnNlICR7ZG9jfWBcbiAgICAgICk7XG4gICAgICBlcnJvci5zZXRQcm9wZXJ0eUVycm9yID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGlmIChkb2MgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgaWYgKG9wdGlvbnMuZm9yYmlkQXJyYXkpIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChrZXlwYXJ0ID09PSAnJCcpIHtcbiAgICAgICAgaWYgKHVzZWRBcnJheUluZGV4KSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ1RvbyBtYW55IHBvc2l0aW9uYWwgKGkuZS4gXFwnJFxcJykgZWxlbWVudHMnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghb3B0aW9ucy5hcnJheUluZGljZXMgfHwgIW9wdGlvbnMuYXJyYXlJbmRpY2VzLmxlbmd0aCkge1xuICAgICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgICAgJ1RoZSBwb3NpdGlvbmFsIG9wZXJhdG9yIGRpZCBub3QgZmluZCB0aGUgbWF0Y2ggbmVlZGVkIGZyb20gdGhlICcgK1xuICAgICAgICAgICAgJ3F1ZXJ5J1xuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBrZXlwYXJ0ID0gb3B0aW9ucy5hcnJheUluZGljZXNbMF07XG4gICAgICAgIHVzZWRBcnJheUluZGV4ID0gdHJ1ZTtcbiAgICAgIH0gZWxzZSBpZiAoaXNOdW1lcmljS2V5KGtleXBhcnQpKSB7XG4gICAgICAgIGtleXBhcnQgPSBwYXJzZUludChrZXlwYXJ0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChvcHRpb25zLm5vQ3JlYXRlKSB7XG4gICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgIGBjYW4ndCBhcHBlbmQgdG8gYXJyYXkgdXNpbmcgc3RyaW5nIGZpZWxkIG5hbWUgWyR7a2V5cGFydH1dYFxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAobGFzdCkge1xuICAgICAgICBrZXlwYXJ0c1tpXSA9IGtleXBhcnQ7IC8vIGhhbmRsZSAnYS4wMSdcbiAgICAgIH1cblxuICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUgJiYga2V5cGFydCA+PSBkb2MubGVuZ3RoKSB7XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICAgIHdoaWxlIChkb2MubGVuZ3RoIDwga2V5cGFydCkge1xuICAgICAgICBkb2MucHVzaChudWxsKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFsYXN0KSB7XG4gICAgICAgIGlmIChkb2MubGVuZ3RoID09PSBrZXlwYXJ0KSB7XG4gICAgICAgICAgZG9jLnB1c2goe30pO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBkb2Nba2V5cGFydF0gIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICBgY2FuJ3QgbW9kaWZ5IGZpZWxkICcke2tleXBhcnRzW2kgKyAxXX0nIG9mIGxpc3QgdmFsdWUgYCArXG4gICAgICAgICAgICBKU09OLnN0cmluZ2lmeShkb2Nba2V5cGFydF0pXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBhc3NlcnRJc1ZhbGlkRmllbGROYW1lKGtleXBhcnQpO1xuXG4gICAgICBpZiAoIShrZXlwYXJ0IGluIGRvYykpIHtcbiAgICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUpIHtcbiAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFsYXN0KSB7XG4gICAgICAgICAgZG9jW2tleXBhcnRdID0ge307XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobGFzdCkge1xuICAgICAgcmV0dXJuIGRvYztcbiAgICB9XG5cbiAgICBkb2MgPSBkb2Nba2V5cGFydF07XG4gIH1cblxuICAvLyBub3RyZWFjaGVkXG59XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uIGZyb20gJy4vbG9jYWxfY29sbGVjdGlvbi5qcyc7XG5pbXBvcnQge1xuICBjb21waWxlRG9jdW1lbnRTZWxlY3RvcixcbiAgaGFzT3duLFxuICBub3RoaW5nTWF0Y2hlcixcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG5jb25zdCBEZWNpbWFsID0gUGFja2FnZVsnbW9uZ28tZGVjaW1hbCddPy5EZWNpbWFsIHx8IGNsYXNzIERlY2ltYWxTdHViIHt9XG5cbi8vIFRoZSBtaW5pbW9uZ28gc2VsZWN0b3IgY29tcGlsZXIhXG5cbi8vIFRlcm1pbm9sb2d5OlxuLy8gIC0gYSAnc2VsZWN0b3InIGlzIHRoZSBFSlNPTiBvYmplY3QgcmVwcmVzZW50aW5nIGEgc2VsZWN0b3Jcbi8vICAtIGEgJ21hdGNoZXInIGlzIGl0cyBjb21waWxlZCBmb3JtICh3aGV0aGVyIGEgZnVsbCBNaW5pbW9uZ28uTWF0Y2hlclxuLy8gICAgb2JqZWN0IG9yIG9uZSBvZiB0aGUgY29tcG9uZW50IGxhbWJkYXMgdGhhdCBtYXRjaGVzIHBhcnRzIG9mIGl0KVxuLy8gIC0gYSAncmVzdWx0IG9iamVjdCcgaXMgYW4gb2JqZWN0IHdpdGggYSAncmVzdWx0JyBmaWVsZCBhbmQgbWF5YmVcbi8vICAgIGRpc3RhbmNlIGFuZCBhcnJheUluZGljZXMuXG4vLyAgLSBhICdicmFuY2hlZCB2YWx1ZScgaXMgYW4gb2JqZWN0IHdpdGggYSAndmFsdWUnIGZpZWxkIGFuZCBtYXliZVxuLy8gICAgJ2RvbnRJdGVyYXRlJyBhbmQgJ2FycmF5SW5kaWNlcycuXG4vLyAgLSBhICdkb2N1bWVudCcgaXMgYSB0b3AtbGV2ZWwgb2JqZWN0IHRoYXQgY2FuIGJlIHN0b3JlZCBpbiBhIGNvbGxlY3Rpb24uXG4vLyAgLSBhICdsb29rdXAgZnVuY3Rpb24nIGlzIGEgZnVuY3Rpb24gdGhhdCB0YWtlcyBpbiBhIGRvY3VtZW50IGFuZCByZXR1cm5zXG4vLyAgICBhbiBhcnJheSBvZiAnYnJhbmNoZWQgdmFsdWVzJy5cbi8vICAtIGEgJ2JyYW5jaGVkIG1hdGNoZXInIG1hcHMgZnJvbSBhbiBhcnJheSBvZiBicmFuY2hlZCB2YWx1ZXMgdG8gYSByZXN1bHRcbi8vICAgIG9iamVjdC5cbi8vICAtIGFuICdlbGVtZW50IG1hdGNoZXInIG1hcHMgZnJvbSBhIHNpbmdsZSB2YWx1ZSB0byBhIGJvb2wuXG5cbi8vIE1haW4gZW50cnkgcG9pbnQuXG4vLyAgIHZhciBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHthOiB7JGd0OiA1fX0pO1xuLy8gICBpZiAobWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoe2E6IDd9KSkgLi4uXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBNYXRjaGVyIHtcbiAgY29uc3RydWN0b3Ioc2VsZWN0b3IsIGlzVXBkYXRlKSB7XG4gICAgLy8gQSBzZXQgKG9iamVjdCBtYXBwaW5nIHN0cmluZyAtPiAqKSBvZiBhbGwgb2YgdGhlIGRvY3VtZW50IHBhdGhzIGxvb2tlZFxuICAgIC8vIGF0IGJ5IHRoZSBzZWxlY3Rvci4gQWxzbyBpbmNsdWRlcyB0aGUgZW1wdHkgc3RyaW5nIGlmIGl0IG1heSBsb29rIGF0IGFueVxuICAgIC8vIHBhdGggKGVnLCAkd2hlcmUpLlxuICAgIHRoaXMuX3BhdGhzID0ge307XG4gICAgLy8gU2V0IHRvIHRydWUgaWYgY29tcGlsYXRpb24gZmluZHMgYSAkbmVhci5cbiAgICB0aGlzLl9oYXNHZW9RdWVyeSA9IGZhbHNlO1xuICAgIC8vIFNldCB0byB0cnVlIGlmIGNvbXBpbGF0aW9uIGZpbmRzIGEgJHdoZXJlLlxuICAgIHRoaXMuX2hhc1doZXJlID0gZmFsc2U7XG4gICAgLy8gU2V0IHRvIGZhbHNlIGlmIGNvbXBpbGF0aW9uIGZpbmRzIGFueXRoaW5nIG90aGVyIHRoYW4gYSBzaW1wbGUgZXF1YWxpdHlcbiAgICAvLyBvciBvbmUgb3IgbW9yZSBvZiAnJGd0JywgJyRndGUnLCAnJGx0JywgJyRsdGUnLCAnJG5lJywgJyRpbicsICckbmluJyB1c2VkXG4gICAgLy8gd2l0aCBzY2FsYXJzIGFzIG9wZXJhbmRzLlxuICAgIHRoaXMuX2lzU2ltcGxlID0gdHJ1ZTtcbiAgICAvLyBTZXQgdG8gYSBkdW1teSBkb2N1bWVudCB3aGljaCBhbHdheXMgbWF0Y2hlcyB0aGlzIE1hdGNoZXIuIE9yIHNldCB0byBudWxsXG4gICAgLy8gaWYgc3VjaCBkb2N1bWVudCBpcyB0b28gaGFyZCB0byBmaW5kLlxuICAgIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgPSB1bmRlZmluZWQ7XG4gICAgLy8gQSBjbG9uZSBvZiB0aGUgb3JpZ2luYWwgc2VsZWN0b3IuIEl0IG1heSBqdXN0IGJlIGEgZnVuY3Rpb24gaWYgdGhlIHVzZXJcbiAgICAvLyBwYXNzZWQgaW4gYSBmdW5jdGlvbjsgb3RoZXJ3aXNlIGlzIGRlZmluaXRlbHkgYW4gb2JqZWN0IChlZywgSURzIGFyZVxuICAgIC8vIHRyYW5zbGF0ZWQgaW50byB7X2lkOiBJRH0gZmlyc3QuIFVzZWQgYnkgY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIgYW5kXG4gICAgLy8gU29ydGVyLl91c2VXaXRoTWF0Y2hlci5cbiAgICB0aGlzLl9zZWxlY3RvciA9IG51bGw7XG4gICAgdGhpcy5fZG9jTWF0Y2hlciA9IHRoaXMuX2NvbXBpbGVTZWxlY3RvcihzZWxlY3Rvcik7XG4gICAgLy8gU2V0IHRvIHRydWUgaWYgc2VsZWN0aW9uIGlzIGRvbmUgZm9yIGFuIHVwZGF0ZSBvcGVyYXRpb25cbiAgICAvLyBEZWZhdWx0IGlzIGZhbHNlXG4gICAgLy8gVXNlZCBmb3IgJG5lYXIgYXJyYXkgdXBkYXRlIChpc3N1ZSAjMzU5OSlcbiAgICB0aGlzLl9pc1VwZGF0ZSA9IGlzVXBkYXRlO1xuICB9XG5cbiAgZG9jdW1lbnRNYXRjaGVzKGRvYykge1xuICAgIGlmIChkb2MgIT09IE9iamVjdChkb2MpKSB7XG4gICAgICB0aHJvdyBFcnJvcignZG9jdW1lbnRNYXRjaGVzIG5lZWRzIGEgZG9jdW1lbnQnKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fZG9jTWF0Y2hlcihkb2MpO1xuICB9XG5cbiAgaGFzR2VvUXVlcnkoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2hhc0dlb1F1ZXJ5O1xuICB9XG5cbiAgaGFzV2hlcmUoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2hhc1doZXJlO1xuICB9XG5cbiAgaXNTaW1wbGUoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2lzU2ltcGxlO1xuICB9XG5cbiAgLy8gR2l2ZW4gYSBzZWxlY3RvciwgcmV0dXJuIGEgZnVuY3Rpb24gdGhhdCB0YWtlcyBvbmUgYXJndW1lbnQsIGFcbiAgLy8gZG9jdW1lbnQuIEl0IHJldHVybnMgYSByZXN1bHQgb2JqZWN0LlxuICBfY29tcGlsZVNlbGVjdG9yKHNlbGVjdG9yKSB7XG4gICAgLy8geW91IGNhbiBwYXNzIGEgbGl0ZXJhbCBmdW5jdGlvbiBpbnN0ZWFkIG9mIGEgc2VsZWN0b3JcbiAgICBpZiAoc2VsZWN0b3IgaW5zdGFuY2VvZiBGdW5jdGlvbikge1xuICAgICAgdGhpcy5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICAgIHRoaXMuX3NlbGVjdG9yID0gc2VsZWN0b3I7XG4gICAgICB0aGlzLl9yZWNvcmRQYXRoVXNlZCgnJyk7XG5cbiAgICAgIHJldHVybiBkb2MgPT4gKHtyZXN1bHQ6ICEhc2VsZWN0b3IuY2FsbChkb2MpfSk7XG4gICAgfVxuXG4gICAgLy8gc2hvcnRoYW5kIC0tIHNjYWxhciBfaWRcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IpKSB7XG4gICAgICB0aGlzLl9zZWxlY3RvciA9IHtfaWQ6IHNlbGVjdG9yfTtcbiAgICAgIHRoaXMuX3JlY29yZFBhdGhVc2VkKCdfaWQnKTtcblxuICAgICAgcmV0dXJuIGRvYyA9PiAoe3Jlc3VsdDogRUpTT04uZXF1YWxzKGRvYy5faWQsIHNlbGVjdG9yKX0pO1xuICAgIH1cblxuICAgIC8vIHByb3RlY3QgYWdhaW5zdCBkYW5nZXJvdXMgc2VsZWN0b3JzLiAgZmFsc2V5IGFuZCB7X2lkOiBmYWxzZXl9IGFyZSBib3RoXG4gICAgLy8gbGlrZWx5IHByb2dyYW1tZXIgZXJyb3IsIGFuZCBub3Qgd2hhdCB5b3Ugd2FudCwgcGFydGljdWxhcmx5IGZvclxuICAgIC8vIGRlc3RydWN0aXZlIG9wZXJhdGlvbnMuXG4gICAgaWYgKCFzZWxlY3RvciB8fCBoYXNPd24uY2FsbChzZWxlY3RvciwgJ19pZCcpICYmICFzZWxlY3Rvci5faWQpIHtcbiAgICAgIHRoaXMuX2lzU2ltcGxlID0gZmFsc2U7XG4gICAgICByZXR1cm4gbm90aGluZ01hdGNoZXI7XG4gICAgfVxuXG4gICAgLy8gVG9wIGxldmVsIGNhbid0IGJlIGFuIGFycmF5IG9yIHRydWUgb3IgYmluYXJ5LlxuICAgIGlmIChBcnJheS5pc0FycmF5KHNlbGVjdG9yKSB8fFxuICAgICAgICBFSlNPTi5pc0JpbmFyeShzZWxlY3RvcikgfHxcbiAgICAgICAgdHlwZW9mIHNlbGVjdG9yID09PSAnYm9vbGVhbicpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBzZWxlY3RvcjogJHtzZWxlY3Rvcn1gKTtcbiAgICB9XG5cbiAgICB0aGlzLl9zZWxlY3RvciA9IEVKU09OLmNsb25lKHNlbGVjdG9yKTtcblxuICAgIHJldHVybiBjb21waWxlRG9jdW1lbnRTZWxlY3RvcihzZWxlY3RvciwgdGhpcywge2lzUm9vdDogdHJ1ZX0pO1xuICB9XG5cbiAgLy8gUmV0dXJucyBhIGxpc3Qgb2Yga2V5IHBhdGhzIHRoZSBnaXZlbiBzZWxlY3RvciBpcyBsb29raW5nIGZvci4gSXQgaW5jbHVkZXNcbiAgLy8gdGhlIGVtcHR5IHN0cmluZyBpZiB0aGVyZSBpcyBhICR3aGVyZS5cbiAgX2dldFBhdGhzKCkge1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh0aGlzLl9wYXRocyk7XG4gIH1cblxuICBfcmVjb3JkUGF0aFVzZWQocGF0aCkge1xuICAgIHRoaXMuX3BhdGhzW3BhdGhdID0gdHJ1ZTtcbiAgfVxufVxuXG4vLyBoZWxwZXJzIHVzZWQgYnkgY29tcGlsZWQgc2VsZWN0b3IgY29kZVxuTG9jYWxDb2xsZWN0aW9uLl9mID0ge1xuICAvLyBYWFggZm9yIF9hbGwgYW5kIF9pbiwgY29uc2lkZXIgYnVpbGRpbmcgJ2lucXVlcnknIGF0IGNvbXBpbGUgdGltZS4uXG4gIF90eXBlKHYpIHtcbiAgICBpZiAodHlwZW9mIHYgPT09ICdudW1iZXInKSB7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHYgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gMjtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHYgPT09ICdib29sZWFuJykge1xuICAgICAgcmV0dXJuIDg7XG4gICAgfVxuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgIHJldHVybiA0O1xuICAgIH1cblxuICAgIGlmICh2ID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gMTA7XG4gICAgfVxuXG4gICAgLy8gbm90ZSB0aGF0IHR5cGVvZigveC8pID09PSBcIm9iamVjdFwiXG4gICAgaWYgKHYgaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICAgIHJldHVybiAxMTtcbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIHYgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiAxMztcbiAgICB9XG5cbiAgICBpZiAodiBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgIHJldHVybiA5O1xuICAgIH1cblxuICAgIGlmIChFSlNPTi5pc0JpbmFyeSh2KSkge1xuICAgICAgcmV0dXJuIDU7XG4gICAgfVxuXG4gICAgaWYgKHYgaW5zdGFuY2VvZiBNb25nb0lELk9iamVjdElEKSB7XG4gICAgICByZXR1cm4gNztcbiAgICB9XG5cbiAgICBpZiAodiBpbnN0YW5jZW9mIERlY2ltYWwpIHtcbiAgICAgIHJldHVybiAxO1xuICAgIH1cblxuICAgIC8vIG9iamVjdFxuICAgIHJldHVybiAzO1xuXG4gICAgLy8gWFhYIHN1cHBvcnQgc29tZS9hbGwgb2YgdGhlc2U6XG4gICAgLy8gMTQsIHN5bWJvbFxuICAgIC8vIDE1LCBqYXZhc2NyaXB0IGNvZGUgd2l0aCBzY29wZVxuICAgIC8vIDE2LCAxODogMzItYml0LzY0LWJpdCBpbnRlZ2VyXG4gICAgLy8gMTcsIHRpbWVzdGFtcFxuICAgIC8vIDI1NSwgbWlua2V5XG4gICAgLy8gMTI3LCBtYXhrZXlcbiAgfSxcblxuICAvLyBkZWVwIGVxdWFsaXR5IHRlc3Q6IHVzZSBmb3IgbGl0ZXJhbCBkb2N1bWVudCBhbmQgYXJyYXkgbWF0Y2hlc1xuICBfZXF1YWwoYSwgYikge1xuICAgIHJldHVybiBFSlNPTi5lcXVhbHMoYSwgYiwge2tleU9yZGVyU2Vuc2l0aXZlOiB0cnVlfSk7XG4gIH0sXG5cbiAgLy8gbWFwcyBhIHR5cGUgY29kZSB0byBhIHZhbHVlIHRoYXQgY2FuIGJlIHVzZWQgdG8gc29ydCB2YWx1ZXMgb2YgZGlmZmVyZW50XG4gIC8vIHR5cGVzXG4gIF90eXBlb3JkZXIodCkge1xuICAgIC8vIGh0dHA6Ly93d3cubW9uZ29kYi5vcmcvZGlzcGxheS9ET0NTL1doYXQraXMrdGhlK0NvbXBhcmUrT3JkZXIrZm9yK0JTT04rVHlwZXNcbiAgICAvLyBYWFggd2hhdCBpcyB0aGUgY29ycmVjdCBzb3J0IHBvc2l0aW9uIGZvciBKYXZhc2NyaXB0IGNvZGU/XG4gICAgLy8gKCcxMDAnIGluIHRoZSBtYXRyaXggYmVsb3cpXG4gICAgLy8gWFhYIG1pbmtleS9tYXhrZXlcbiAgICByZXR1cm4gW1xuICAgICAgLTEsICAvLyAobm90IGEgdHlwZSlcbiAgICAgIDEsICAgLy8gbnVtYmVyXG4gICAgICAyLCAgIC8vIHN0cmluZ1xuICAgICAgMywgICAvLyBvYmplY3RcbiAgICAgIDQsICAgLy8gYXJyYXlcbiAgICAgIDUsICAgLy8gYmluYXJ5XG4gICAgICAtMSwgIC8vIGRlcHJlY2F0ZWRcbiAgICAgIDYsICAgLy8gT2JqZWN0SURcbiAgICAgIDcsICAgLy8gYm9vbFxuICAgICAgOCwgICAvLyBEYXRlXG4gICAgICAwLCAgIC8vIG51bGxcbiAgICAgIDksICAgLy8gUmVnRXhwXG4gICAgICAtMSwgIC8vIGRlcHJlY2F0ZWRcbiAgICAgIDEwMCwgLy8gSlMgY29kZVxuICAgICAgMiwgICAvLyBkZXByZWNhdGVkIChzeW1ib2wpXG4gICAgICAxMDAsIC8vIEpTIGNvZGVcbiAgICAgIDEsICAgLy8gMzItYml0IGludFxuICAgICAgOCwgICAvLyBNb25nbyB0aW1lc3RhbXBcbiAgICAgIDEgICAgLy8gNjQtYml0IGludFxuICAgIF1bdF07XG4gIH0sXG5cbiAgLy8gY29tcGFyZSB0d28gdmFsdWVzIG9mIHVua25vd24gdHlwZSBhY2NvcmRpbmcgdG8gQlNPTiBvcmRlcmluZ1xuICAvLyBzZW1hbnRpY3MuIChhcyBhbiBleHRlbnNpb24sIGNvbnNpZGVyICd1bmRlZmluZWQnIHRvIGJlIGxlc3MgdGhhblxuICAvLyBhbnkgb3RoZXIgdmFsdWUuKSByZXR1cm4gbmVnYXRpdmUgaWYgYSBpcyBsZXNzLCBwb3NpdGl2ZSBpZiBiIGlzXG4gIC8vIGxlc3MsIG9yIDAgaWYgZXF1YWxcbiAgX2NtcChhLCBiKSB7XG4gICAgaWYgKGEgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIGIgPT09IHVuZGVmaW5lZCA/IDAgOiAtMTtcbiAgICB9XG5cbiAgICBpZiAoYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG5cbiAgICBsZXQgdGEgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUoYSk7XG4gICAgbGV0IHRiID0gTG9jYWxDb2xsZWN0aW9uLl9mLl90eXBlKGIpO1xuXG4gICAgY29uc3Qgb2EgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGVvcmRlcih0YSk7XG4gICAgY29uc3Qgb2IgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGVvcmRlcih0Yik7XG5cbiAgICBpZiAob2EgIT09IG9iKSB7XG4gICAgICByZXR1cm4gb2EgPCBvYiA/IC0xIDogMTtcbiAgICB9XG5cbiAgICAvLyBYWFggbmVlZCB0byBpbXBsZW1lbnQgdGhpcyBpZiB3ZSBpbXBsZW1lbnQgU3ltYm9sIG9yIGludGVnZXJzLCBvclxuICAgIC8vIFRpbWVzdGFtcFxuICAgIGlmICh0YSAhPT0gdGIpIHtcbiAgICAgIHRocm93IEVycm9yKCdNaXNzaW5nIHR5cGUgY29lcmNpb24gbG9naWMgaW4gX2NtcCcpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gNykgeyAvLyBPYmplY3RJRFxuICAgICAgLy8gQ29udmVydCB0byBzdHJpbmcuXG4gICAgICB0YSA9IHRiID0gMjtcbiAgICAgIGEgPSBhLnRvSGV4U3RyaW5nKCk7XG4gICAgICBiID0gYi50b0hleFN0cmluZygpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gOSkgeyAvLyBEYXRlXG4gICAgICAvLyBDb252ZXJ0IHRvIG1pbGxpcy5cbiAgICAgIHRhID0gdGIgPSAxO1xuICAgICAgYSA9IGEuZ2V0VGltZSgpO1xuICAgICAgYiA9IGIuZ2V0VGltZSgpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gMSkgeyAvLyBkb3VibGVcbiAgICAgIGlmIChhIGluc3RhbmNlb2YgRGVjaW1hbCkge1xuICAgICAgICByZXR1cm4gYS5taW51cyhiKS50b051bWJlcigpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIGEgLSBiO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0YiA9PT0gMikgLy8gc3RyaW5nXG4gICAgICByZXR1cm4gYSA8IGIgPyAtMSA6IGEgPT09IGIgPyAwIDogMTtcblxuICAgIGlmICh0YSA9PT0gMykgeyAvLyBPYmplY3RcbiAgICAgIC8vIHRoaXMgY291bGQgYmUgbXVjaCBtb3JlIGVmZmljaWVudCBpbiB0aGUgZXhwZWN0ZWQgY2FzZSAuLi5cbiAgICAgIGNvbnN0IHRvQXJyYXkgPSBvYmplY3QgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBbXTtcblxuICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICByZXN1bHQucHVzaChrZXksIG9iamVjdFtrZXldKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgIH07XG5cbiAgICAgIHJldHVybiBMb2NhbENvbGxlY3Rpb24uX2YuX2NtcCh0b0FycmF5KGEpLCB0b0FycmF5KGIpKTtcbiAgICB9XG5cbiAgICBpZiAodGEgPT09IDQpIHsgLy8gQXJyYXlcbiAgICAgIGZvciAobGV0IGkgPSAwOyA7IGkrKykge1xuICAgICAgICBpZiAoaSA9PT0gYS5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm4gaSA9PT0gYi5sZW5ndGggPyAwIDogLTE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaSA9PT0gYi5sZW5ndGgpIHtcbiAgICAgICAgICByZXR1cm4gMTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHMgPSBMb2NhbENvbGxlY3Rpb24uX2YuX2NtcChhW2ldLCBiW2ldKTtcbiAgICAgICAgaWYgKHMgIT09IDApIHtcbiAgICAgICAgICByZXR1cm4gcztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0YSA9PT0gNSkgeyAvLyBiaW5hcnlcbiAgICAgIC8vIFN1cnByaXNpbmdseSwgYSBzbWFsbCBiaW5hcnkgYmxvYiBpcyBhbHdheXMgbGVzcyB0aGFuIGEgbGFyZ2Ugb25lIGluXG4gICAgICAvLyBNb25nby5cbiAgICAgIGlmIChhLmxlbmd0aCAhPT0gYi5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIGEubGVuZ3RoIC0gYi5sZW5ndGg7XG4gICAgICB9XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYS5sZW5ndGg7IGkrKykge1xuICAgICAgICBpZiAoYVtpXSA8IGJbaV0pIHtcbiAgICAgICAgICByZXR1cm4gLTE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoYVtpXSA+IGJbaV0pIHtcbiAgICAgICAgICByZXR1cm4gMTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gMDtcbiAgICB9XG5cbiAgICBpZiAodGEgPT09IDgpIHsgLy8gYm9vbGVhblxuICAgICAgaWYgKGEpIHtcbiAgICAgICAgcmV0dXJuIGIgPyAwIDogMTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGIgPyAtMSA6IDA7XG4gICAgfVxuXG4gICAgaWYgKHRhID09PSAxMCkgLy8gbnVsbFxuICAgICAgcmV0dXJuIDA7XG5cbiAgICBpZiAodGEgPT09IDExKSAvLyByZWdleHBcbiAgICAgIHRocm93IEVycm9yKCdTb3J0aW5nIG5vdCBzdXBwb3J0ZWQgb24gcmVndWxhciBleHByZXNzaW9uJyk7IC8vIFhYWFxuXG4gICAgLy8gMTM6IGphdmFzY3JpcHQgY29kZVxuICAgIC8vIDE0OiBzeW1ib2xcbiAgICAvLyAxNTogamF2YXNjcmlwdCBjb2RlIHdpdGggc2NvcGVcbiAgICAvLyAxNjogMzItYml0IGludGVnZXJcbiAgICAvLyAxNzogdGltZXN0YW1wXG4gICAgLy8gMTg6IDY0LWJpdCBpbnRlZ2VyXG4gICAgLy8gMjU1OiBtaW5rZXlcbiAgICAvLyAxMjc6IG1heGtleVxuICAgIGlmICh0YSA9PT0gMTMpIC8vIGphdmFzY3JpcHQgY29kZVxuICAgICAgdGhyb3cgRXJyb3IoJ1NvcnRpbmcgbm90IHN1cHBvcnRlZCBvbiBKYXZhc2NyaXB0IGNvZGUnKTsgLy8gWFhYXG5cbiAgICB0aHJvdyBFcnJvcignVW5rbm93biB0eXBlIHRvIHNvcnQnKTtcbiAgfSxcbn07XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uXyBmcm9tICcuL2xvY2FsX2NvbGxlY3Rpb24uanMnO1xuaW1wb3J0IE1hdGNoZXIgZnJvbSAnLi9tYXRjaGVyLmpzJztcbmltcG9ydCBTb3J0ZXIgZnJvbSAnLi9zb3J0ZXIuanMnO1xuXG5Mb2NhbENvbGxlY3Rpb24gPSBMb2NhbENvbGxlY3Rpb25fO1xuTWluaW1vbmdvID0ge1xuICAgIExvY2FsQ29sbGVjdGlvbjogTG9jYWxDb2xsZWN0aW9uXyxcbiAgICBNYXRjaGVyLFxuICAgIFNvcnRlclxufTtcbiIsIi8vIE9ic2VydmVIYW5kbGU6IHRoZSByZXR1cm4gdmFsdWUgb2YgYSBsaXZlIHF1ZXJ5LlxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgT2JzZXJ2ZUhhbmRsZSB7fVxuIiwiaW1wb3J0IHtcbiAgRUxFTUVOVF9PUEVSQVRPUlMsXG4gIGVxdWFsaXR5RWxlbWVudE1hdGNoZXIsXG4gIGV4cGFuZEFycmF5c0luQnJhbmNoZXMsXG4gIGhhc093bixcbiAgaXNPcGVyYXRvck9iamVjdCxcbiAgbWFrZUxvb2t1cEZ1bmN0aW9uLFxuICByZWdleHBFbGVtZW50TWF0Y2hlcixcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG4vLyBHaXZlIGEgc29ydCBzcGVjLCB3aGljaCBjYW4gYmUgaW4gYW55IG9mIHRoZXNlIGZvcm1zOlxuLy8gICB7XCJrZXkxXCI6IDEsIFwia2V5MlwiOiAtMX1cbi8vICAgW1tcImtleTFcIiwgXCJhc2NcIl0sIFtcImtleTJcIiwgXCJkZXNjXCJdXVxuLy8gICBbXCJrZXkxXCIsIFtcImtleTJcIiwgXCJkZXNjXCJdXVxuLy9cbi8vICguLiB3aXRoIHRoZSBmaXJzdCBmb3JtIGJlaW5nIGRlcGVuZGVudCBvbiB0aGUga2V5IGVudW1lcmF0aW9uXG4vLyBiZWhhdmlvciBvZiB5b3VyIGphdmFzY3JpcHQgVk0sIHdoaWNoIHVzdWFsbHkgZG9lcyB3aGF0IHlvdSBtZWFuIGluXG4vLyB0aGlzIGNhc2UgaWYgdGhlIGtleSBuYW1lcyBkb24ndCBsb29rIGxpa2UgaW50ZWdlcnMgLi4pXG4vL1xuLy8gcmV0dXJuIGEgZnVuY3Rpb24gdGhhdCB0YWtlcyB0d28gb2JqZWN0cywgYW5kIHJldHVybnMgLTEgaWYgdGhlXG4vLyBmaXJzdCBvYmplY3QgY29tZXMgZmlyc3QgaW4gb3JkZXIsIDEgaWYgdGhlIHNlY29uZCBvYmplY3QgY29tZXNcbi8vIGZpcnN0LCBvciAwIGlmIG5laXRoZXIgb2JqZWN0IGNvbWVzIGJlZm9yZSB0aGUgb3RoZXIuXG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFNvcnRlciB7XG4gIGNvbnN0cnVjdG9yKHNwZWMpIHtcbiAgICB0aGlzLl9zb3J0U3BlY1BhcnRzID0gW107XG4gICAgdGhpcy5fc29ydEZ1bmN0aW9uID0gbnVsbDtcblxuICAgIGNvbnN0IGFkZFNwZWNQYXJ0ID0gKHBhdGgsIGFzY2VuZGluZykgPT4ge1xuICAgICAgaWYgKCFwYXRoKSB7XG4gICAgICAgIHRocm93IEVycm9yKCdzb3J0IGtleXMgbXVzdCBiZSBub24tZW1wdHknKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHBhdGguY2hhckF0KDApID09PSAnJCcpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoYHVuc3VwcG9ydGVkIHNvcnQga2V5OiAke3BhdGh9YCk7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuX3NvcnRTcGVjUGFydHMucHVzaCh7XG4gICAgICAgIGFzY2VuZGluZyxcbiAgICAgICAgbG9va3VwOiBtYWtlTG9va3VwRnVuY3Rpb24ocGF0aCwge2ZvclNvcnQ6IHRydWV9KSxcbiAgICAgICAgcGF0aFxuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGlmIChzcGVjIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgIHNwZWMuZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBlbGVtZW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgIGFkZFNwZWNQYXJ0KGVsZW1lbnQsIHRydWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGFkZFNwZWNQYXJ0KGVsZW1lbnRbMF0sIGVsZW1lbnRbMV0gIT09ICdkZXNjJyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHNwZWMgPT09ICdvYmplY3QnKSB7XG4gICAgICBPYmplY3Qua2V5cyhzcGVjKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICAgIGFkZFNwZWNQYXJ0KGtleSwgc3BlY1trZXldID49IDApO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2Ygc3BlYyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgdGhpcy5fc29ydEZ1bmN0aW9uID0gc3BlYztcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgRXJyb3IoYEJhZCBzb3J0IHNwZWNpZmljYXRpb246ICR7SlNPTi5zdHJpbmdpZnkoc3BlYyl9YCk7XG4gICAgfVxuXG4gICAgLy8gSWYgYSBmdW5jdGlvbiBpcyBzcGVjaWZpZWQgZm9yIHNvcnRpbmcsIHdlIHNraXAgdGhlIHJlc3QuXG4gICAgaWYgKHRoaXMuX3NvcnRGdW5jdGlvbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFRvIGltcGxlbWVudCBhZmZlY3RlZEJ5TW9kaWZpZXIsIHdlIHBpZ2d5LWJhY2sgb24gdG9wIG9mIE1hdGNoZXInc1xuICAgIC8vIGFmZmVjdGVkQnlNb2RpZmllciBjb2RlOyB3ZSBjcmVhdGUgYSBzZWxlY3RvciB0aGF0IGlzIGFmZmVjdGVkIGJ5IHRoZVxuICAgIC8vIHNhbWUgbW9kaWZpZXJzIGFzIHRoaXMgc29ydCBvcmRlci4gVGhpcyBpcyBvbmx5IGltcGxlbWVudGVkIG9uIHRoZVxuICAgIC8vIHNlcnZlci5cbiAgICBpZiAodGhpcy5hZmZlY3RlZEJ5TW9kaWZpZXIpIHtcbiAgICAgIGNvbnN0IHNlbGVjdG9yID0ge307XG5cbiAgICAgIHRoaXMuX3NvcnRTcGVjUGFydHMuZm9yRWFjaChzcGVjID0+IHtcbiAgICAgICAgc2VsZWN0b3Jbc3BlYy5wYXRoXSA9IDE7XG4gICAgICB9KTtcblxuICAgICAgdGhpcy5fc2VsZWN0b3JGb3JBZmZlY3RlZEJ5TW9kaWZpZXIgPSBuZXcgTWluaW1vbmdvLk1hdGNoZXIoc2VsZWN0b3IpO1xuICAgIH1cblxuICAgIHRoaXMuX2tleUNvbXBhcmF0b3IgPSBjb21wb3NlQ29tcGFyYXRvcnMoXG4gICAgICB0aGlzLl9zb3J0U3BlY1BhcnRzLm1hcCgoc3BlYywgaSkgPT4gdGhpcy5fa2V5RmllbGRDb21wYXJhdG9yKGkpKVxuICAgICk7XG4gIH1cblxuICBnZXRDb21wYXJhdG9yKG9wdGlvbnMpIHtcbiAgICAvLyBJZiBzb3J0IGlzIHNwZWNpZmllZCBvciBoYXZlIG5vIGRpc3RhbmNlcywganVzdCB1c2UgdGhlIGNvbXBhcmF0b3IgZnJvbVxuICAgIC8vIHRoZSBzb3VyY2Ugc3BlY2lmaWNhdGlvbiAod2hpY2ggZGVmYXVsdHMgdG8gXCJldmVyeXRoaW5nIGlzIGVxdWFsXCIuXG4gICAgLy8gaXNzdWUgIzM1OTlcbiAgICAvLyBodHRwczovL2RvY3MubW9uZ29kYi5jb20vbWFudWFsL3JlZmVyZW5jZS9vcGVyYXRvci9xdWVyeS9uZWFyLyNzb3J0LW9wZXJhdGlvblxuICAgIC8vIHNvcnQgZWZmZWN0aXZlbHkgb3ZlcnJpZGVzICRuZWFyXG4gICAgaWYgKHRoaXMuX3NvcnRTcGVjUGFydHMubGVuZ3RoIHx8ICFvcHRpb25zIHx8ICFvcHRpb25zLmRpc3RhbmNlcykge1xuICAgICAgcmV0dXJuIHRoaXMuX2dldEJhc2VDb21wYXJhdG9yKCk7XG4gICAgfVxuXG4gICAgY29uc3QgZGlzdGFuY2VzID0gb3B0aW9ucy5kaXN0YW5jZXM7XG5cbiAgICAvLyBSZXR1cm4gYSBjb21wYXJhdG9yIHdoaWNoIGNvbXBhcmVzIHVzaW5nICRuZWFyIGRpc3RhbmNlcy5cbiAgICByZXR1cm4gKGEsIGIpID0+IHtcbiAgICAgIGlmICghZGlzdGFuY2VzLmhhcyhhLl9pZCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoYE1pc3NpbmcgZGlzdGFuY2UgZm9yICR7YS5faWR9YCk7XG4gICAgICB9XG5cbiAgICAgIGlmICghZGlzdGFuY2VzLmhhcyhiLl9pZCkpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoYE1pc3NpbmcgZGlzdGFuY2UgZm9yICR7Yi5faWR9YCk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBkaXN0YW5jZXMuZ2V0KGEuX2lkKSAtIGRpc3RhbmNlcy5nZXQoYi5faWQpO1xuICAgIH07XG4gIH1cblxuICAvLyBUYWtlcyBpbiB0d28ga2V5czogYXJyYXlzIHdob3NlIGxlbmd0aHMgbWF0Y2ggdGhlIG51bWJlciBvZiBzcGVjXG4gIC8vIHBhcnRzLiBSZXR1cm5zIG5lZ2F0aXZlLCAwLCBvciBwb3NpdGl2ZSBiYXNlZCBvbiB1c2luZyB0aGUgc29ydCBzcGVjIHRvXG4gIC8vIGNvbXBhcmUgZmllbGRzLlxuICBfY29tcGFyZUtleXMoa2V5MSwga2V5Mikge1xuICAgIGlmIChrZXkxLmxlbmd0aCAhPT0gdGhpcy5fc29ydFNwZWNQYXJ0cy5sZW5ndGggfHxcbiAgICAgICAga2V5Mi5sZW5ndGggIT09IHRoaXMuX3NvcnRTcGVjUGFydHMubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBFcnJvcignS2V5IGhhcyB3cm9uZyBsZW5ndGgnKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fa2V5Q29tcGFyYXRvcihrZXkxLCBrZXkyKTtcbiAgfVxuXG4gIC8vIEl0ZXJhdGVzIG92ZXIgZWFjaCBwb3NzaWJsZSBcImtleVwiIGZyb20gZG9jIChpZSwgb3ZlciBlYWNoIGJyYW5jaCksIGNhbGxpbmdcbiAgLy8gJ2NiJyB3aXRoIHRoZSBrZXkuXG4gIF9nZW5lcmF0ZUtleXNGcm9tRG9jKGRvYywgY2IpIHtcbiAgICBpZiAodGhpcy5fc29ydFNwZWNQYXJ0cy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignY2FuXFwndCBnZW5lcmF0ZSBrZXlzIHdpdGhvdXQgYSBzcGVjJyk7XG4gICAgfVxuXG4gICAgY29uc3QgcGF0aEZyb21JbmRpY2VzID0gaW5kaWNlcyA9PiBgJHtpbmRpY2VzLmpvaW4oJywnKX0sYDtcblxuICAgIGxldCBrbm93blBhdGhzID0gbnVsbDtcblxuICAgIC8vIG1hcHMgaW5kZXggLT4gKHsnJyAtPiB2YWx1ZX0gb3Ige3BhdGggLT4gdmFsdWV9KVxuICAgIGNvbnN0IHZhbHVlc0J5SW5kZXhBbmRQYXRoID0gdGhpcy5fc29ydFNwZWNQYXJ0cy5tYXAoc3BlYyA9PiB7XG4gICAgICAvLyBFeHBhbmQgYW55IGxlYWYgYXJyYXlzIHRoYXQgd2UgZmluZCwgYW5kIGlnbm9yZSB0aG9zZSBhcnJheXNcbiAgICAgIC8vIHRoZW1zZWx2ZXMuICAoV2UgbmV2ZXIgc29ydCBiYXNlZCBvbiBhbiBhcnJheSBpdHNlbGYuKVxuICAgICAgbGV0IGJyYW5jaGVzID0gZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyhzcGVjLmxvb2t1cChkb2MpLCB0cnVlKTtcblxuICAgICAgLy8gSWYgdGhlcmUgYXJlIG5vIHZhbHVlcyBmb3IgYSBrZXkgKGVnLCBrZXkgZ29lcyB0byBhbiBlbXB0eSBhcnJheSksXG4gICAgICAvLyBwcmV0ZW5kIHdlIGZvdW5kIG9uZSB1bmRlZmluZWQgdmFsdWUuXG4gICAgICBpZiAoIWJyYW5jaGVzLmxlbmd0aCkge1xuICAgICAgICBicmFuY2hlcyA9IFt7IHZhbHVlOiB2b2lkIDAgfV07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGVsZW1lbnQgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICAgICAgbGV0IHVzZWRQYXRocyA9IGZhbHNlO1xuXG4gICAgICBicmFuY2hlcy5mb3JFYWNoKGJyYW5jaCA9PiB7XG4gICAgICAgIGlmICghYnJhbmNoLmFycmF5SW5kaWNlcykge1xuICAgICAgICAgIC8vIElmIHRoZXJlIGFyZSBubyBhcnJheSBpbmRpY2VzIGZvciBhIGJyYW5jaCwgdGhlbiBpdCBtdXN0IGJlIHRoZVxuICAgICAgICAgIC8vIG9ubHkgYnJhbmNoLCBiZWNhdXNlIHRoZSBvbmx5IHRoaW5nIHRoYXQgcHJvZHVjZXMgbXVsdGlwbGUgYnJhbmNoZXNcbiAgICAgICAgICAvLyBpcyB0aGUgdXNlIG9mIGFycmF5cy5cbiAgICAgICAgICBpZiAoYnJhbmNoZXMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgdGhyb3cgRXJyb3IoJ211bHRpcGxlIGJyYW5jaGVzIGJ1dCBubyBhcnJheSB1c2VkPycpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGVsZW1lbnRbJyddID0gYnJhbmNoLnZhbHVlO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHVzZWRQYXRocyA9IHRydWU7XG5cbiAgICAgICAgY29uc3QgcGF0aCA9IHBhdGhGcm9tSW5kaWNlcyhicmFuY2guYXJyYXlJbmRpY2VzKTtcblxuICAgICAgICBpZiAoaGFzT3duLmNhbGwoZWxlbWVudCwgcGF0aCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcihgZHVwbGljYXRlIHBhdGg6ICR7cGF0aH1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGVsZW1lbnRbcGF0aF0gPSBicmFuY2gudmFsdWU7XG5cbiAgICAgICAgLy8gSWYgdHdvIHNvcnQgZmllbGRzIGJvdGggZ28gaW50byBhcnJheXMsIHRoZXkgaGF2ZSB0byBnbyBpbnRvIHRoZVxuICAgICAgICAvLyBleGFjdCBzYW1lIGFycmF5cyBhbmQgd2UgaGF2ZSB0byBmaW5kIHRoZSBzYW1lIHBhdGhzLiAgVGhpcyBpc1xuICAgICAgICAvLyByb3VnaGx5IHRoZSBzYW1lIGNvbmRpdGlvbiB0aGF0IG1ha2VzIE1vbmdvREIgdGhyb3cgdGhpcyBzdHJhbmdlXG4gICAgICAgIC8vIGVycm9yIG1lc3NhZ2UuICBlZywgdGhlIG1haW4gdGhpbmcgaXMgdGhhdCBpZiBzb3J0IHNwZWMgaXMge2E6IDEsXG4gICAgICAgIC8vIGI6MX0gdGhlbiBhIGFuZCBiIGNhbm5vdCBib3RoIGJlIGFycmF5cy5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gKEluIE1vbmdvREIgaXQgc2VlbXMgdG8gYmUgT0sgdG8gaGF2ZSB7YTogMSwgJ2EueC55JzogMX0gd2hlcmUgJ2EnXG4gICAgICAgIC8vIGFuZCAnYS54LnknIGFyZSBib3RoIGFycmF5cywgYnV0IHdlIGRvbid0IGFsbG93IHRoaXMgZm9yIG5vdy5cbiAgICAgICAgLy8gI05lc3RlZEFycmF5U29ydFxuICAgICAgICAvLyBYWFggYWNoaWV2ZSBmdWxsIGNvbXBhdGliaWxpdHkgaGVyZVxuICAgICAgICBpZiAoa25vd25QYXRocyAmJiAhaGFzT3duLmNhbGwoa25vd25QYXRocywgcGF0aCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignY2Fubm90IGluZGV4IHBhcmFsbGVsIGFycmF5cycpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgaWYgKGtub3duUGF0aHMpIHtcbiAgICAgICAgLy8gU2ltaWxhcmx5IHRvIGFib3ZlLCBwYXRocyBtdXN0IG1hdGNoIGV2ZXJ5d2hlcmUsIHVubGVzcyB0aGlzIGlzIGFcbiAgICAgICAgLy8gbm9uLWFycmF5IGZpZWxkLlxuICAgICAgICBpZiAoIWhhc093bi5jYWxsKGVsZW1lbnQsICcnKSAmJlxuICAgICAgICAgICAgT2JqZWN0LmtleXMoa25vd25QYXRocykubGVuZ3RoICE9PSBPYmplY3Qua2V5cyhlbGVtZW50KS5sZW5ndGgpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignY2Fubm90IGluZGV4IHBhcmFsbGVsIGFycmF5cyEnKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICh1c2VkUGF0aHMpIHtcbiAgICAgICAga25vd25QYXRocyA9IHt9O1xuXG4gICAgICAgIE9iamVjdC5rZXlzKGVsZW1lbnQpLmZvckVhY2gocGF0aCA9PiB7XG4gICAgICAgICAga25vd25QYXRoc1twYXRoXSA9IHRydWU7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gZWxlbWVudDtcbiAgICB9KTtcblxuICAgIGlmICgha25vd25QYXRocykge1xuICAgICAgLy8gRWFzeSBjYXNlOiBubyB1c2Ugb2YgYXJyYXlzLlxuICAgICAgY29uc3Qgc29sZUtleSA9IHZhbHVlc0J5SW5kZXhBbmRQYXRoLm1hcCh2YWx1ZXMgPT4ge1xuICAgICAgICBpZiAoIWhhc093bi5jYWxsKHZhbHVlcywgJycpKSB7XG4gICAgICAgICAgdGhyb3cgRXJyb3IoJ25vIHZhbHVlIGluIHNvbGUga2V5IGNhc2U/Jyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWVzWycnXTtcbiAgICAgIH0pO1xuXG4gICAgICBjYihzb2xlS2V5KTtcblxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIE9iamVjdC5rZXlzKGtub3duUGF0aHMpLmZvckVhY2gocGF0aCA9PiB7XG4gICAgICBjb25zdCBrZXkgPSB2YWx1ZXNCeUluZGV4QW5kUGF0aC5tYXAodmFsdWVzID0+IHtcbiAgICAgICAgaWYgKGhhc093bi5jYWxsKHZhbHVlcywgJycpKSB7XG4gICAgICAgICAgcmV0dXJuIHZhbHVlc1snJ107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWhhc093bi5jYWxsKHZhbHVlcywgcGF0aCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignbWlzc2luZyBwYXRoPycpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlc1twYXRoXTtcbiAgICAgIH0pO1xuXG4gICAgICBjYihrZXkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gUmV0dXJucyBhIGNvbXBhcmF0b3IgdGhhdCByZXByZXNlbnRzIHRoZSBzb3J0IHNwZWNpZmljYXRpb24gKGJ1dCBub3RcbiAgLy8gaW5jbHVkaW5nIGEgcG9zc2libGUgZ2VvcXVlcnkgZGlzdGFuY2UgdGllLWJyZWFrZXIpLlxuICBfZ2V0QmFzZUNvbXBhcmF0b3IoKSB7XG4gICAgaWYgKHRoaXMuX3NvcnRGdW5jdGlvbikge1xuICAgICAgcmV0dXJuIHRoaXMuX3NvcnRGdW5jdGlvbjtcbiAgICB9XG5cbiAgICAvLyBJZiB3ZSdyZSBvbmx5IHNvcnRpbmcgb24gZ2VvcXVlcnkgZGlzdGFuY2UgYW5kIG5vIHNwZWNzLCBqdXN0IHNheVxuICAgIC8vIGV2ZXJ5dGhpbmcgaXMgZXF1YWwuXG4gICAgaWYgKCF0aGlzLl9zb3J0U3BlY1BhcnRzLmxlbmd0aCkge1xuICAgICAgcmV0dXJuIChkb2MxLCBkb2MyKSA9PiAwO1xuICAgIH1cblxuICAgIHJldHVybiAoZG9jMSwgZG9jMikgPT4ge1xuICAgICAgY29uc3Qga2V5MSA9IHRoaXMuX2dldE1pbktleUZyb21Eb2MoZG9jMSk7XG4gICAgICBjb25zdCBrZXkyID0gdGhpcy5fZ2V0TWluS2V5RnJvbURvYyhkb2MyKTtcbiAgICAgIHJldHVybiB0aGlzLl9jb21wYXJlS2V5cyhrZXkxLCBrZXkyKTtcbiAgICB9O1xuICB9XG5cbiAgLy8gRmluZHMgdGhlIG1pbmltdW0ga2V5IGZyb20gdGhlIGRvYywgYWNjb3JkaW5nIHRvIHRoZSBzb3J0IHNwZWNzLiAgKFdlIHNheVxuICAvLyBcIm1pbmltdW1cIiBoZXJlIGJ1dCB0aGlzIGlzIHdpdGggcmVzcGVjdCB0byB0aGUgc29ydCBzcGVjLCBzbyBcImRlc2NlbmRpbmdcIlxuICAvLyBzb3J0IGZpZWxkcyBtZWFuIHdlJ3JlIGZpbmRpbmcgdGhlIG1heCBmb3IgdGhhdCBmaWVsZC4pXG4gIC8vXG4gIC8vIE5vdGUgdGhhdCB0aGlzIGlzIE5PVCBcImZpbmQgdGhlIG1pbmltdW0gdmFsdWUgb2YgdGhlIGZpcnN0IGZpZWxkLCB0aGVcbiAgLy8gbWluaW11bSB2YWx1ZSBvZiB0aGUgc2Vjb25kIGZpZWxkLCBldGNcIi4uLiBpdCdzIFwiY2hvb3NlIHRoZVxuICAvLyBsZXhpY29ncmFwaGljYWxseSBtaW5pbXVtIHZhbHVlIG9mIHRoZSBrZXkgdmVjdG9yLCBhbGxvd2luZyBvbmx5IGtleXMgd2hpY2hcbiAgLy8geW91IGNhbiBmaW5kIGFsb25nIHRoZSBzYW1lIHBhdGhzXCIuICBpZSwgZm9yIGEgZG9jIHthOiBbe3g6IDAsIHk6IDV9LCB7eDpcbiAgLy8gMSwgeTogM31dfSB3aXRoIHNvcnQgc3BlYyB7J2EueCc6IDEsICdhLnknOiAxfSwgdGhlIG9ubHkga2V5cyBhcmUgWzAsNV0gYW5kXG4gIC8vIFsxLDNdLCBhbmQgdGhlIG1pbmltdW0ga2V5IGlzIFswLDVdOyBub3RhYmx5LCBbMCwzXSBpcyBOT1QgYSBrZXkuXG4gIF9nZXRNaW5LZXlGcm9tRG9jKGRvYykge1xuICAgIGxldCBtaW5LZXkgPSBudWxsO1xuXG4gICAgdGhpcy5fZ2VuZXJhdGVLZXlzRnJvbURvYyhkb2MsIGtleSA9PiB7XG4gICAgICBpZiAobWluS2V5ID09PSBudWxsKSB7XG4gICAgICAgIG1pbktleSA9IGtleTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAodGhpcy5fY29tcGFyZUtleXMoa2V5LCBtaW5LZXkpIDwgMCkge1xuICAgICAgICBtaW5LZXkgPSBrZXk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gbWluS2V5O1xuICB9XG5cbiAgX2dldFBhdGhzKCkge1xuICAgIHJldHVybiB0aGlzLl9zb3J0U3BlY1BhcnRzLm1hcChwYXJ0ID0+IHBhcnQucGF0aCk7XG4gIH1cblxuICAvLyBHaXZlbiBhbiBpbmRleCAnaScsIHJldHVybnMgYSBjb21wYXJhdG9yIHRoYXQgY29tcGFyZXMgdHdvIGtleSBhcnJheXMgYmFzZWRcbiAgLy8gb24gZmllbGQgJ2knLlxuICBfa2V5RmllbGRDb21wYXJhdG9yKGkpIHtcbiAgICBjb25zdCBpbnZlcnQgPSAhdGhpcy5fc29ydFNwZWNQYXJ0c1tpXS5hc2NlbmRpbmc7XG5cbiAgICByZXR1cm4gKGtleTEsIGtleTIpID0+IHtcbiAgICAgIGNvbnN0IGNvbXBhcmUgPSBMb2NhbENvbGxlY3Rpb24uX2YuX2NtcChrZXkxW2ldLCBrZXkyW2ldKTtcbiAgICAgIHJldHVybiBpbnZlcnQgPyAtY29tcGFyZSA6IGNvbXBhcmU7XG4gICAgfTtcbiAgfVxufVxuXG4vLyBHaXZlbiBhbiBhcnJheSBvZiBjb21wYXJhdG9yc1xuLy8gKGZ1bmN0aW9ucyAoYSxiKS0+KG5lZ2F0aXZlIG9yIHBvc2l0aXZlIG9yIHplcm8pKSwgcmV0dXJucyBhIHNpbmdsZVxuLy8gY29tcGFyYXRvciB3aGljaCB1c2VzIGVhY2ggY29tcGFyYXRvciBpbiBvcmRlciBhbmQgcmV0dXJucyB0aGUgZmlyc3Rcbi8vIG5vbi16ZXJvIHZhbHVlLlxuZnVuY3Rpb24gY29tcG9zZUNvbXBhcmF0b3JzKGNvbXBhcmF0b3JBcnJheSkge1xuICByZXR1cm4gKGEsIGIpID0+IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNvbXBhcmF0b3JBcnJheS5sZW5ndGg7ICsraSkge1xuICAgICAgY29uc3QgY29tcGFyZSA9IGNvbXBhcmF0b3JBcnJheVtpXShhLCBiKTtcbiAgICAgIGlmIChjb21wYXJlICE9PSAwKSB7XG4gICAgICAgIHJldHVybiBjb21wYXJlO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiAwO1xuICB9O1xufVxuIl19
