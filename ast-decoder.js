'use strict';

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports'], factory);
  } else if (typeof exports !== 'undefined') {
    factory(exports);
  } else {
    factory((root.astDecoder = {}));
  }
}(this, function (exports) {
  var common        = require("./ast-common.js");
  var Configuration = require("./configuration.js");

  var NamedTable  = common.NamedTable,
      UniqueTable = common.UniqueTable,
      StringTable = common.StringTable,
      ObjectTable = common.ObjectTable;


  var IoTrace = false;
  var TraceInlining = false;
  var TraceInlinedTypeCount = 0;


  function ValueReader (bytes, index, count, configuration, description) {
    if (!configuration)
      throw new Error("Configuration required");

    this.bytes         = bytes;
    this.byteReader    = encoding.makeByteReader(bytes, index, count);
    this.scratchBytes  = new Uint8Array  (128);
    this.scratchU32    = new Uint32Array (this.scratchBytes.buffer);
    this.scratchI32    = new Int32Array  (this.scratchBytes.buffer);
    this.scratchF64    = new Float64Array(this.scratchBytes.buffer);
    this.configuration = configuration;
    this.description   = description || null;
  }

  ValueReader.prototype.peekByte = function (offset) {
    return this.byteReader.peek(offset);
  };

  ValueReader.prototype.readByte = function () {
    var result = this.byteReader.read();

    if (IoTrace)
      console.log(this.description + " read  byte", result.toString(16));

    return result;
  };

  ValueReader.prototype.readBytes = function (buffer, offset, count) {
    if (arguments.length === 1) {
      var temp = new Uint8Array(buffer | 0);
      if (this.readBytes(temp, 0, buffer | 0))
        return temp;
      else
        return false;
    }

    for (var i = 0; i < count; i++) {
      var b = this.byteReader.read();

      if (b === false)
        return false;

      buffer[offset + i] = b;
    }

    return true;
  };

  ValueReader.prototype.readScratchBytes = function (count) {
    return this.readBytes(this.scratchBytes, 0, count);
  };

  ValueReader.prototype.readUint32 = function () {
    var b1 = this.byteReader.peek(0),
        b2 = this.byteReader.peek(1),
        b3 = this.byteReader.peek(2);

    if (!this.readScratchBytes(4))
      return false;

    var result = this.scratchU32[0];
    if (IoTrace)
      console.log(this.description + " read  uint", result.toString(16), "[" + b1.toString(16) + " " + b2.toString(16) + " " + b3.toString(16) + "]");
    return result;
  };

  ValueReader.prototype.readUint24 = function () {
    this.scratchU32[0] = 0;

    if (!this.readScratchBytes(3))
      return false;

    var result = this.scratchU32[0];
    if (IoTrace)
      console.log(this.description + " read  uint24", result.toString(16));
    return result;
  };

  ValueReader.prototype.readInt32 = function () {
    if (!this.readScratchBytes(4))
      return false;

    var result = this.scratchI32[0];
    if (IoTrace)
      console.log(this.description + " read  int", result.toString(16));
    return result;
  };

  ValueReader.prototype.readVarUint32 = function () {
    var b1 = this.byteReader.peek(0),
        b2 = this.byteReader.peek(1),
        b3 = this.byteReader.peek(2);

    if (!this.configuration.EnableVarints) {
      if (this.configuration.ThreeByteIndices)
        return this.readUint24();
      else
        return this.readUint32();
    }

    var result = common.readLEBUint32(this.byteReader);
    if (IoTrace)
      console.log(this.description + " read  varuint", result.toString(16), "[" + b1.toString(16) + " " + b2.toString(16) + " " + b3.toString(16) + "]");
    return result;
  };

  ValueReader.prototype.readVarInt32 = function () {
    if (!this.configuration.EnableVarints)
      return this.readInt32();

    var result = common.readLEBInt32(this.byteReader);
    if (IoTrace)
      console.log(this.description + " read  varint", result.toString(16));
    return result;
  };

  ValueReader.prototype.readIndex = function () {
    var indexRaw = this.readVarUint32();

    if (indexRaw === 0)
      return 0xFFFFFFFF;
    else
      return indexRaw - 1;
  };

  ValueReader.prototype.readFloat64 = function () {
    if (!this.readScratchBytes(8))
      return false;

    var result = this.scratchF64[0];
    if (IoTrace)
      console.log(this.description + " read  float64", result.toFixed(4));
    return result;
  };

  ValueReader.prototype.readUtf8String = function () {
    var length = 0, position;

    if (!this.configuration.NullTerminatedStrings) {
      length = this.readIndex();
      if (length === false)
        return false;

      // HACK So we can encode null distinct from ""
      if (length === 0xFFFFFFFF)
        return null;

      if (length === 0)
        return "";

      position = this.byteReader.getPosition();

    } else {
      // HACK So we can encode null distinct from ""
      if (this.peekByte() === 0xFF) {
        this.readByte();
        return null;
      }

      var b;

      position = this.byteReader.getPosition();
      while (Number(b = this.readByte()) > 0)
        length++;
    }

    var result = encoding.UTF8.decode(this.bytes, position, length);

    if (!this.configuration.NullTerminatedStrings)
      this.byteReader.skip(length);

    return result;
  };

  ValueReader.prototype.readSubstream = function () {
    var prior = IoTrace;
    IoTrace = false;

    var description = this.readUtf8String();
    var length = this.readUint32();

    var result = new ValueReader(this.bytes, this.byteReader.getPosition(), length, this.configuration, description);

    this.byteReader.skip(length);

    var length2 = this.readUint32();
    if (length2 !== length)
      throw new Error("Length footer didn't match length header");

    IoTrace = prior;
    return result;
  };

  ValueReader.prototype.skip = function (distance) {
    this.byteReader.skip(distance);
  };


  function JsAstModule (configuration, shapes) {
    this.configuration = configuration;
    this.shapes        = shapes;

    this.tags         = null;
    this.objects      = null;
    this.valueStreams = Object.create(null);

    this.typeTagStream     = null;
    this.inliningStream    = null;
    this.packedIndexStream = null;

    this.root = null;
  };


  function _decodeTypeTag (module, tagIndex) {
    if (false)
      console.log(
        "read type tag " + tagIndex +
        " (" + module.tags[tagIndex] + ") " +
        " as varuint from " + reader.description
      );

    var tag = module.tags[tagIndex];
    if (typeof (tag) !== "string")
      throw new Error("Invalid tag index: " + tagIndex);

    return tag;
  };


  function readTypeTag (reader, module) {
    if (module.configuration.TypeTagStream)
      reader = module.typeTagStream;

    var tagIndex = reader.readIndex();
    if (tagIndex === false)
      throw new Error("Truncated file");

    return _decodeTypeTag(module, tagIndex);
  };


  function getTableEntry (table, index) {
    if (!table)
      throw new Error("Table expected");

    if (index === 0xFFFFFFFF)
      return null;

    if ((index < 0) || (index >= table.length))
      throw new Error("Invalid index " + index);

    var result = table[index];
    if (typeof (result) === "undefined")
      throw new Error("Uninitialized at index " + index);

    return result;
  };


  function readInliningFlag (reader, module) {
    var flag = module.inliningStream.readByte();
    return flag;
  };


  var nullBundle = {
    isInlined: true,
    isNull:   true,
    tag:      "null",
    index:    0xFFFFFFFF
  };

  function readInliningBundle (reader, module) {
    if (module.configuration.PackedInliningFlags) {
      if (module.configuration.PackedIndexStream)
        reader = module.packedIndexStream;

      var packedIndex = reader.readIndex();

      if (packedIndex === 0xFFFFFFFF) {
        // console.log("unpacked FFFFFFFF -> null");
        return nullBundle;
      }

      var flag = packedIndex & 0x1;
      var index = packedIndex >> 1;
      // console.log("unpacked", packedIndex.toString(16), "->", flag, index);

      if (flag) {
        return {
          isInlined: true,
          tag:       _decodeTypeTag(module, index)
        };
      } else {
        return {
          isInlined: false,
          index:     index
        }
      }

    } else {
      var flag  = readInliningFlag(reader, module);

      if (flag === 0xFF)
        return nullBundle;

      if (flag) {
        return {
          isInlined: true,
          tag:       readTypeTag(reader, module)
        }
      } else {
        var index = reader.readIndex();
        return {
          isInlined: false,
          index:    index
        }
      }
    }
  };


  function deserializeObjectReference (reader, module, tag) {
    var isUntypedObject = (tag === "object");
    if (!isUntypedObject) {
      var shape = module.shapes.get(tag);
      if (!shape)
        throw new Error("Unhandled value type " + tag + " with no shape");
    }

    var objectTable;
    if (IoTrace)
      console.log(reader.description + " read  object");

    objectTable = module.objects;

    var shouldConditionalInline = 
      reader.configuration.ConditionalInlining &&
      (tag !== "any");
    var index;

    if (shouldConditionalInline) {
      var bundle = readInliningBundle(reader, module);

      if (bundle.isNull) {
        return null;

      } else if (bundle.isInlined) {
        var result = new Object();

        deserializeObjectContents(reader, module, result, bundle.isInlined, bundle.tag);

        return result;

      } else {
        index = bundle.index;
      }

    } else {
      index = reader.readIndex();
    }

    return getTableEntry(objectTable, index);
  };

  function deserializeValueWithKnownTag (reader, module, tag) {
    switch (tag) {
      case "any": {
        tag = readTypeTag(reader, module);
        if (tag === "any")
          throw new Error("Found 'any' type tag when reading any-tag");

        if (IoTrace)
          console.log(reader.description + " read  any ->");
        return deserializeValueWithKnownTag(reader, module, tag);
      }

      case "symbol":
        if (IoTrace)
          console.log(reader.description + " read  symbol");
        
        if (module.configuration.InternedSymbols) {
          var index = reader.readIndex();
          return index;
        } else {
          var string = reader.readUtf8String();
          return string;
        }

      case "string":
        if (IoTrace)
          console.log(reader.description + " read  string");
        var string = reader.readUtf8String();
        return string;

      case "array":
        var length = reader.readVarUint32();
        var array = new Array(length);

        if (length > 0) {
          var elementTag = readTypeTag(reader, module);
          if (IoTrace)
            console.log(reader.description + " read  array of type " + elementTag + " with " + length + " element(s)");

          for (var i = 0; i < length; i++) {
            var element = deserializeValueWithKnownTag(reader, module, elementTag);
            array[i] = element;
          }
        } else {
          if (IoTrace)
            console.log(reader.description + " read  empty array");
        }

        return array;

      case "boolean":
        return Boolean(reader.readByte());

      case "integer":
        return reader.readInt32();

      case "double":
        return reader.readFloat64();

      default:
      case "object":
        return deserializeObjectReference(reader, module, tag);
    }

    throw new Error("unexpected");
  };


  function getReaderForField (defaultReader, module, field, tag) {
    if (module.configuration.ValueStreamPerType) {
      var reader = module.valueStreams[tag];
      if (!reader)
        throw new Error("No value stream for tag '" + tag + "'");

      return reader;
    } else {
      return defaultReader;
    }
  };


  function deserializeFieldValue (reader, module, shape, field, overrideReader) {
      var tag = common.pickTagForField(field, function (t) {
        var shape = module.shapes.get(t);
        return shape;
      });

      if (
        overrideReader &&
        reader.configuration.NoOverridingPrimitiveStream &&
        common.TagIsPrimitive[tag]
      )
        overrideReader = false;

      if (!overrideReader) {
        var oldReader = reader;
        reader = getReaderForField(reader, module, field, tag);

        if (IoTrace) {
          if (reader === oldReader)
            console.log("field " + field.name + " did not pick reader -> " + reader.description);
          else
            console.log("field " + field.name + " picked reader " + oldReader.description + " -> " + reader.description);
        }
      } else if (IoTrace) {
        console.log("field " + field.name + " reader forced " + reader.description);
      }

      var value = deserializeValueWithKnownTag(reader, module, tag);
      return value;
  }


  function deserializeObjectContents (reader, module, obj, isInline, inlinedTypeTag) {
    var shapeName;

    if (typeof (inlinedTypeTag) === "string")
      shapeName = inlinedTypeTag;
    else
      shapeName = readTypeTag(reader, module);

    var shouldOverride = false;
    if (isInline) {
      var trace = TraceInlining || (TraceInlinedTypeCount-- > 0);

      if (
        module.configuration.ValueStreamPerType && 
        module.configuration.PartitionedInlining
      ) {
        reader = module.valueStreams[shapeName];
        shouldOverride = true;
        if (trace)
          console.log("Reading inlined " + shapeName + " from " + reader.description);
      } else {
        if (trace)
          console.log("reading inlined " + shapeName);
      }
    }

    var shape = module.shapes.get(shapeName);
    if (!shape)
      throw new Error("Could not find shape '" + shapeName + "'");

    obj[module.shapes.shapeKey] = shapeName;

    for (var i = 0, l = shape.fields.length; i < l; i++) {
      var fd = shape.fields[i];

      try {
        var value = deserializeFieldValue(reader, module, shape, fd, shouldOverride);
      } catch (e) {
        console.log(
          "Failed while reading field " + fd.name + 
          " of an " + shapeName
        );
        throw e;
      }

      obj[fd.name] = value;
      if (IoTrace)
        console.log("// " + fd.name + " =", value);
    }

    if (IoTrace)
      console.log(obj);
  };


  function deserializeTable (reader, payloadReader) {
    var count = reader.readUint32();
    if (count === false)
      throw new Error("Truncated file");

    var result = new Array(count);

    for (var i = 0; i < count; i++) {
      var item = payloadReader(reader);
      result[i] = item;
    }

    return result;
  };


  function deserializeObjectTable (reader, module) {
    var count = reader.readUint32();
    if (count === false)
      throw new Error("Truncated file");

    var table = module.objects;

    if (count !== table.length)
      throw new Error("Read " + count + " object(s) into table of length " + table.length);

    for (var i = 0; i < count; i++) {
      var obj = table[i];
      deserializeObjectContents(reader, module, obj, false);
    }
  };


  function allocateObjectTable (module, count) {
    var table = new Array(count);
    for (var i = 0; i < count; i++) {
      var o = new Object();

      table[i] = o;
    };

    table.baseIndex = 0;

    if (module.objects)
      throw new Error("Object table already allocated");
    else
      module.objects = table;
  };


  function bytesToModule (configuration, shapes, bytes) {
    var reader = new ValueReader(bytes, 0, bytes.length, configuration, "module");

    var magic = reader.readBytes(common.Magic.length);
    if (JSON.stringify(magic) !== JSON.stringify(common.Magic)) {
      console.log(magic, common.Magic);
      throw new Error("Magic header does not match");
    }

    var result = new JsAstModule(configuration, shapes);

    // The lengths are stored in front of the tables themselves,
    //  this simplifies table deserialization...
    var tagCount    = reader.readUint32();
    var objectCount = reader.readUint32();


    var readUtf8String = function (_) { 
      var text = _.readUtf8String();
      if (text === false)
        throw new Error("Truncated file");
      return text;
    };

    var tagReader    = reader.readSubstream();
    result.tags = deserializeTable(tagReader, readUtf8String);


    if (
      configuration.ConditionalInlining &&
      !configuration.PackedInliningFlags
    )
      result.inliningStream = reader.readSubstream();

    if (configuration.TypeTagStream)
      result.typeTagStream = reader.readSubstream();

    if (
      configuration.PackedInliningFlags && 
      configuration.PackedIndexStream
    )
      result.packedIndexStream = reader.readSubstream();


    if (configuration.ValueStreamPerType)
    for (var i = 0; i < result.tags.length; i++) {
      var tagIndex = reader.readIndex();
      var tag = result.tags[tagIndex];

      var valueStream = reader.readSubstream();
      result.valueStreams[tag] = valueStream;
    }


    allocateObjectTable(result, objectCount);


    var objectReader = reader.readSubstream();

    deserializeObjectTable(objectReader, result);


    var rootReader = reader.readSubstream();

    result.root = deserializeValueWithKnownTag(rootReader, result, "any");
    if (!result.root)
      throw new Error("Failed to retrieve root from module");

    return result;
  };


  exports.PrettyJson    = common.PrettyJson;

  exports.ShapeTable    = common.ShapeTable;
  exports.ValueReader   = ValueReader;

  exports.bytesToModule = bytesToModule;
}));