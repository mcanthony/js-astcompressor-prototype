// Partially based on cashew asm.js parser (see Upstream/cashew/LICENSE)

'use strict';

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['exports'], factory);
  } else if (typeof exports !== 'undefined') {
    factory(exports);
  } else {
    factory((root.asmParse = {}));
  }
}(this, function (exports) {
  var tokenizer = require("./asm-tokenizer.js");
  var treeBuilder = require("./json-treebuilder.js");

  var Tokenizer       = tokenizer.Tokenizer;
  var JsonTreeBuilder = treeBuilder.JSON;


  var TraceTokenization       = true;
  var TraceParsingStack       = false;
  var TraceOperatorPrecedence = false;

  var BinaryPrecedences = ([
    ["*", "/", "%"],
    ["+", "-"],
    ["<<", ">>", ">>>"],
    ["<", "<=", ">", ">=", "in", "instanceof"],
    ["==", "!=", "===", "!=="],
    ["&"], ["^"], ["|"], ["&&"], ["||"]
  ]).map(function (p) {
    var result = Object.create(null);
    for (var i = 0, l = p.length; i < l; i++)
      result[p[i]] = true;
    return result;
  });


  function ChainExpressionNode (e) {
    this.expression = e;
  };

  function ChainOperatorNode (o) {
    this.operator = o;
  };


  function ExpressionChain (treeBuilder) {
    this.items = [];
    this.builder = treeBuilder;
  };

  ExpressionChain.prototype.pushExpression = function (e) {
    this.items.push(new ChainExpressionNode(e));
  };

  ExpressionChain.prototype.pushOperator = function (o) {
    this.items.push(new ChainOperatorNode(o));
  };

  ExpressionChain.prototype.isExpression = function (i) {
    var n = this.items[i];
    return (n instanceof ChainExpressionNode);
  };

  ExpressionChain.prototype.isOperator = function (i) {
    var n = this.items[i];
    return (n instanceof ChainOperatorNode);
  };

  ExpressionChain.prototype.at = function (i) {
    var n = this.items[i];

    if (n instanceof ChainExpressionNode)
      return n.expression;
    else if (n instanceof ChainOperatorNode)
      return n.operator;
    else
      return null;
  };

  ExpressionChain.prototype.replaceWithExpression = function (first, last, expression) {
    var count = (last - first) + 1;
    var node = new ChainExpressionNode(expression);
    this.items.splice(first, count, node);
  };
  
  ExpressionChain.prototype.log = function () {
    if (TraceOperatorPrecedence)
      console.log("chain", this.items);      
  }

  ExpressionChain.prototype.applyDecrementAndIncrement = function () {
    this.log();

    for (var i = 0; i < this.length; i++) {
      switch (this.at(i)) {
        case "++":
        case "--":
          var newExpression;
          var isPrefix = this.isExpression(i + 1);
          var isPostfix = this.isExpression(i - 1);

          // FIXME: This doesn't detect and reject scenarios where the ++/--
          //  operators are being used on a non-identifier, but that's probably fine

          if (isPostfix) {
            newExpression = this.builder.makePostfixMutationExpression(
              this.at(i),
              this.at(i - 1)
            );
            this.replaceWithExpression(i - 1, i, newExpression)
            i -= 1;
          } else if (isPrefix) {
            newExpression = this.builder.makePrefixMutationExpression(
              this.at(i),
              this.at(i + 1)
            );
            this.replaceWithExpression(i, i + 1, newExpression)
          } else {
            throw new Error("Found a '" + this.at(i) + "' surrounded by operators");
          }

          break;
      }
    }
  };

  ExpressionChain.prototype.applyUnaryOperators = function () {
    this.log();

    for (var i = this.length - 2; i >= 0; i--) {
      switch (this.at(i)) {
        case "+":
        case "-":
          if (this.isExpression(i - 1) &&
              this.isExpression(i + 1)) {
            // This is binary arithmetic, so don't process it here
            break;
          } else {
            // Fall-through
          }

        case "!":
        case "~":
        case "typeof":
        case "void":
        case "delete":
          if (!this.isExpression(i + 1))
            throw new Error("Found a prefix operator before a non-expression");

          var rhs = this.at(i + 1);
          var newExpression = this.builder.makeUnaryOperatorExpression(
            this.at(i),
            this.at(i + 1)
          );

          this.replaceWithExpression(i, i + 1, newExpression);

          break;
      }
    }
  };

  ExpressionChain.prototype.applyBinaryOperators = function () {
    this.log();

    for (var p = 0; p < BinaryPrecedences.length; p++) {
      var table = BinaryPrecedences[p];

      for (var i = 1; i < (this.length - 1); i++) {
        if (!this.isOperator(i))
          continue;

        if (table[this.at(i)]) {
          if (
            !this.isExpression(i - 1) ||
            !this.isExpression(i + 1)
          )
            throw new Error("Found a binary operator without a lhs & rhs");

          var lhs = this.at(i - 1);
          var rhs = this.at(i + 1);
          var newExpression = this.builder.makeBinaryOperatorExpression(
            this.at(i),
            lhs, rhs
          );

          this.replaceWithExpression(i - 1, i + 1, newExpression);          
        }
      }

    }
  };

  ExpressionChain.prototype.applyTernaryOperator = function () {
    this.log();

    for (var i = this.length - 2; i >= 0; i--) {
      if (!this.isOperator(i))
        continue;

      var op = this.at(i);

      // FIXME: I honestly have no idea how to implement this correctly.
      // Need to read up on the exact parsing rules.

      if (op === "?") {
        throw new Error("Ternary not implemented");
      } else if (op === ":") {
        throw new Error("Ternary not implemented");
      }
    }
  };

  ExpressionChain.prototype.applyAssignmentOperators = function () {
    this.log();

    for (var i = 1; i < (this.length - 1); i++) {
      switch (this.at(i)) {
        case "=":
        case "+=":
        case "-=":
        case "*=":
        case "/=":
        case "%=":
        case "<<=":
        case ">>=":
        case ">>>=":
        case "&=":
        case "^=":
        case "|=":
          if (
            !this.isExpression(i - 1) ||
            !this.isExpression(i + 1)
          )
            throw new Error("Found an assignment operator without a lhs & rhs");

          // TODO: Assert that LHS is an identifier?

          var lhs = this.at(i - 1);
          var rhs = this.at(i + 1);
          var newExpression = this.builder.makeAssignmentOperatorExpression(
            this.at(i),
            lhs, rhs
          );

          this.replaceWithExpression(i - 1, i + 1, newExpression);          
          break;
      }
    }
  };

  Object.defineProperty(ExpressionChain.prototype, "length", {
    enumerable: true,
    configurable: false,
    get: function () {
      return this.items.length;
    },
    set: function (l) {
      this.items.length = l;
    }
  });


  function Parser (tokenizer, treeBuilder) {
    this.tokenizer = tokenizer;
    this.builder = treeBuilder;
    this._rewound = null;

    this.previousStackFrames = [];
  };

  Parser.prototype.getIndentChars = function (n) {
    var indentChars = "";

    for (var i = 0; i < n - 1; i++)
      indentChars += "..";

    if (n)
      indentChars += "  ";

    return indentChars;
  };

  Parser.prototype.readToken = function () {
    var result;

    var indentLevel = 0;
    if (TraceParsingStack) {
      var r = /at ([A-Za-z0-9$_\.]*) /g;
      Error.stackTraceLimit = 128;
      var e = new Error();
      var stack = e.stack;
      var stackFrames = [], frame = null;

      while ((frame = r.exec(stack)) !== null) {
        frame = frame[1];
        if (frame.indexOf("Parser.") !== 0)
          continue;
        else if (frame.indexOf(".readToken") >= 0)
          continue;
        else if (frame.indexOf(".expectToken") >= 0)
          continue;

        stackFrames.push(frame);
      }

      stackFrames.reverse();

      var newSubframes = false;

      for (var i = 0, l = Math.max(stackFrames.length, this.previousStackFrames.length); i < l; i++) {
        var previousFrame = this.previousStackFrames[i];
        frame = stackFrames[i];

        if (previousFrame === frame)
          continue;

        if (!previousFrame)
          console.log(this.getIndentChars(i) + frame + " {");
        else if (previousFrame && !frame) {
          console.log(this.getIndentChars(i) + "} // " + previousFrame);
          break;
        } else {
          var ic = this.getIndentChars(i);
          if (!newSubframes)
            console.log(ic + "} // " + previousFrame);

          console.log(ic + frame + " {");
          newSubframes = true;
        }
      }

      this.previousStackFrames = stackFrames;
      indentLevel = stackFrames.length;
    }

    if (this._rewound) {
      result = this._rewound;
      this._rewound = null;

      if (TraceTokenization)
        console.log(this.getIndentChars(indentLevel) + "(rewound)");
    } else {
      result = this.tokenizer.read();

      if (TraceTokenization)
        console.log(this.getIndentChars(indentLevel) + result.type, JSON.stringify(result.value));
    }

    return result;
  };

  Parser.prototype.rewind = function (token) {
    if (this._rewound)
      throw new Error("Already rewound");
    else
      this._rewound = token;
  };

  Parser.prototype.expectToken = function (type, value) {
    var token = this.readToken();
    if (token.type === type) {
      if ((arguments.length === 2) && (token.value !== value)) {
        return this.abort("Expected a '" + type + "' with value '" + value + "', got '" + token.value + "'");
      } else {
        return token.value;
      }
    }

    return this.abort("Expected a token of type '" + type + "', got '" + token.type + "'.");
  };

  Parser.prototype.abort = function () {
    console.log.apply(console, arguments);
    throw new Error(arguments[0] || "Aborted");
  };

  Parser.prototype.parseTopLevel = function () {
    var result = this.builder.makeTopLevelBlock();

    this.parseBlockInterior(result);

    return result;
  };

  // parses the interior of a multi-statement block (i.e. the { has been consumed)
  // aborts at eof or uneven } (end of multi-statement block)
  Parser.prototype.parseBlockInterior = function (block) {
    while (true) {
      var stmt = this.parseStatement(block);

      if (stmt === false)
        break;

      // console.log("Statement", stmt);
      this.builder.appendToBlock(block, stmt);
    }
  };

  Parser.prototype.parseIfStatement = function () {
    this.expectToken("separator", "(");

    var cond = this.parseExpression("subexpression");

    var trueStatement = this.parseStatement(), falseStatement = null;

    var maybeElse = this.readToken();
    if (
      (maybeElse.type === "keyword") &&
      (maybeElse.value === "else")
    ) {
      falseStatement = this.parseStatement();
    } else {
      this.rewind();
    }

    return this.builder.makeIfStatement(cond, trueStatement, falseStatement);
  };

  Parser.prototype.parseFunctionExpression = function () {
    var name = null;

    var token = this.readToken();
    if (token.type === "identifier") {
      name = token.value;

      this.expectToken("separator", "(");
    } else if (
      (token.type !== "separator") ||
      (token.value !== "(")
    ) {
      return this.abort("Expected a function name or an argument name list");
    }

    var argumentNames = [];

    token = this.readToken();

    while (
      (token = this.readToken()) && 
      (
        (token.type === "identifier") ||
        (
          (token.type === "operator") &&
          (token.value === ",")
        )
      )
    ) {

      if (token.type === "identifier")
        argumentNames.push(token.value);
      else;
        // Ignore comma
    }

    if (
      (token.type !== "separator") ||
      (token.value !== ")")
    ) {
      return this.abort("Expected an argument name list terminator or another argument name");
    }

    this.expectToken("separator", "{");

    var body = this.builder.makeBlock();
    this.parseBlockInterior();

    return this.builder.makeFunctionExpression(
      name, argumentNames, body
    );
  };

  // Parses complex keywords.
  // Returns false if the keyword was not handled by the parser.
  Parser.prototype.parseKeyword = function (keyword) {
    switch (keyword) {
      case "function":
        return this.parseFunctionExpression();

      case "if":
        return this.parseIfStatement();

      default:
        return false;
    }
  };

  Parser.prototype.parseArrayLiteral = function () {
    var elements = [];

    var item = null, abort = false;
    function aborter () { abort = true; }

    while (
      !abort && 
      (item = this.parseExpression("array-literal", aborter)) !== false
    ) {
      elements.push(item);
    }

    return this.builder.makeArrayLiteralExpression(elements);
  };

  Parser.prototype.parseObjectLiteral = function () {
    var pairs = [];

    var key = null, value = null, abort = false;
    function aborter () { abort = true; }

    while (
      !abort && 
      (
        key &&
        (value = this.parseExpression("object-literal", aborter)) !== false
      ) ||
      (
        (key = this.parseExpression("object-literal", aborter)) !== false
      )
    ) {
      if (key && value) {
        pairs.push([key, value]);
        key = value = null;
      } else {
        this.expectToken("separator", ":");
      }
    }

    return this.builder.makeObjectLiteralExpression(pairs);
  };

  Parser.prototype.parseInvocation = function (callee) {
    var argumentValues = [], argumentValue = null, abort = false;
    function aborter () { abort = true; }

    while (
      !abort && 
      (argumentValue = this.parseExpression("argument-list", aborter)) !== false
    ) {
      argumentValues.push(argumentValue);
    }

    return this.builder.makeInvocationExpression(
      callee, argumentValues
    );
  };

  // Parses a single expression. Handles nesting.
  Parser.prototype.parseExpression = function (context, terminatorCallback) {
    var terminators;

    switch (context) {
      // Free-standing expression (no surrounding parentheses).
      case "statement":
        terminators = ";}"
        break;

      // Parenthesized expression.
      case "subexpression":
        terminators = ")"
        break;

      // Array subscript index.
      case "subscript":
        terminators = "]"
        break;

      // Single argument within argument list.
      case "argument-list":
        terminators = "),";
        break;

      // Single value within array literal.
      case "array-literal":
        terminators = "],";
        break;

      // Single key/value pair within object literal.
      case "object-literal":
        terminators = "},:";
        break;

      default:
        return this.abort("Unsupported expression context '" + context + "'");
    }

    var token = null;
    // HACK: Any non-nested expression elements are splatted onto the end of chain
    //  before being resolved in one final pass at the end. This enables us to
    //  properly handle operator precedence without having to go spelunking inside
    //  nodes constructed by the Builder.
    var chain = new ExpressionChain(this.builder);
    // Stores the most recently constructed expression. Some tokens wrap this or modify it
    var lhs = null;

    iter:
    while (token = this.readToken()) {
      switch (token.type) {
        case "separator":
          // We handle expected terminators here, so if they get encountered below,
          //  they're probably a syntax error.
          if (terminators.indexOf(token.value) >= 0) {
            // This notifies the caller that we hit a terminator while parsing.
            // The argument lets them decide how to handle the terminator.
            // The callback is not invoked for commas, even though they can terminate.
            if (terminatorCallback)
              terminatorCallback(token.value);

            break iter;
          }

          switch (token.value) {
            case "(":
              // Subexpression or function invocation
              // These are high-precedence and complicated so we just handle them now

              if (lhs) {
                // Function invocation
                lhs = this.parseInvocation(lhs);
              } else {
                // Subexpression
                lhs = this.parseExpression("subexpression");
              }

              break;

            case "{":
              if (lhs) {
                return this.abort("Unexpected { juxtaposed with expression");
              } else {
                lhs = this.parseObjectLiteral();
              }

              break;

            case "[":
              // Subscript expression or array literal

              if (lhs) {
                // Subscripting
                // High-precedence so we can do it here
                var index = this.parseExpression("subscript");
                lhs = this.builder.makeSubscriptExpression(lhs, index);
              } else {
                // Array literal
                lhs = this.parseArrayLiteral();
              }

              break;

            default:
              return this.abort("Unexpected '" + token.value + "' within expression");
          }

          break;

        case "operator":
          if (token.value === ",") {
            if (terminators.indexOf(",") >= 0) {
              // The comma operator has minimum precedence so in scenarios where
              //  we want to abort at one, it's fine.
              // We don't invoke the termination callback since commas never require
              //  a special outer response
              break iter;

            } if (lhs) {
              // We could do this manually here, but it's easier to just fold the
              //  comma expression logic in with the rest of the precedence &
              //  associativity logic.
              chain.pushExpression(lhs);
              lhs = null;
              chain.pushOperator(",");

            } else {
              return this.abort("Expected expression before ,");
            }

          } else if (token.value === ":") {
            if (terminators.indexOf(":") >= 0) {
              // Like with the comma, we break but don't invoke the termination callback
              break iter;
            } else {
              if (lhs) {
                chain.pushExpression(lhs);
                lhs = null;
              }

              chain.pushOperator(token.value);
            }

          } else if (token.value === ".") {
            // Member access operator
            if (!lhs)
              this.abort("Expected expression before .");

            var identifier = this.expectToken("identifier");
            lhs = this.builder.makeMemberAccessExpression(lhs, identifier);

          } else {
            // Operators push expressions and themselves onto the chain
            //  so that at the end of things we can order them by precedence
            //  and apply associativity.

            if (lhs) {
              chain.pushExpression(lhs);
              lhs = null;
            }

            chain.pushOperator(token.value);
          }

          break;

        case "identifier":
          lhs = this.builder.makeIdentifierExpression(token.value);
          break;

        case "keyword":
          // Attempt to parse complex keywords
          var kw = this.parseKeyword(token.value);
          if (kw === false) {
            return this.abort("Unhandled keyword '" + token.value + "' in expression");
          } else {
            lhs = kw;
          }

          break;

        case "integer":
        case "double":
        case "string":
          lhs = this.builder.makeLiteralExpression(token.type, token.value);
          break;
      }
    }

    // Now we finalize the chain, and apply precedence sorting
    if (lhs) {
      chain.pushExpression(lhs);
      lhs = null;
    }

    // At this point the chain will be a stream of operators and expressions.
    // Operators are raw string literals, expressions are objects (from the builder).
    // We don't need to know anything about the expressions, just know that they 
    //  aren't operators (i.e. not strings) so we can wrap them in other expression
    //  types.

    if (!chain.length) {
      // In some contexts this is meaningful - array and object literals.
      if (
        (context === "array-literal") ||
        (context === "object-literal")
      )
        return false;
      else
        return this.abort("No expression parsed");
    }

    // The common case is going to be a chain containing exactly one expression.
    // No work to be done there!
    if (chain.length > 1) {
      // The right solution here is probably a modified version of the shunting-yard
      //  algorithm, but it would need a handful of modifications to handle JS's oddball
      //  operators, so I'm going with slow-but-correct here.
      chain.applyDecrementAndIncrement();
      chain.applyUnaryOperators();
      chain.applyBinaryOperators();
      chain.applyTernaryOperator();
      chain.applyAssignmentOperators();
    }

    if (chain.length === 1)
      return chain.at(0);
    else {
      console.log("chain", chain.items);
      return this.abort("Left with more than one result after expression resolution");
    }
  };

  // parses a single statement, returns false if it hit a block-closing token.
  // handles nested blocks.
  Parser.prototype.parseStatement = function (block) {
    var token = null, stmt = null, expr = null;

    iter:
    while (token = this.readToken()) {
      switch (token.type) {
        case "separator":
          switch (token.value) {
            case "{":
              // Read nested block scope. Meaningless, but important to parse
              //  correctly.
              // FIXME: How do we distinguish between a free-standing object literal,
              //  and a block scope?
              var childBlock = this.builder.makeBlock();
              stmt = this.builder.makeBlockStatement(childBlock);

              this.parseBlockInterior(childBlock);

              return stmt;

            case "}":
              return false;

            case ";":
              // HACK: Just skip stray semicolons. We don't care about
              //  no-op statements, and this lets us avoid conditionally
              //  eating a trailing ;.
              continue iter;

            case "(":              
              expr = this.parseExpression("subexpression");
              break iter;

            default:
              // Fall-through
          }

        default:
          this.rewind(token);
          expr = this.parseExpression("statement");
          break iter;

      }
    }

    if (expr) {
      if (expr.type.indexOf("Statement"))
        // HACK: If parsing produced a statement instead of an expression,
        //  just use it
        return expr;
      else if (expr.type === "Function")
        // HACK: If parsing produced a free-standing function expression,
        //  convert it to a function statement
        return this.builder.makeFunctionStatement(expr);
      else
        return this.builder.makeExpressionStatement(expr);
    }

    this.abort("No tokens read");
  };


  // parses an input character stream into a tree of asm.js AST nodes
  // input is a ByteReader (see encoding.js)
  // treebuilder is an object that implements the abstract TreeBuilder interface
  function parse (input, treeBuilder) {
    var tokenizer = new Tokenizer(input);
    var parser    = new Parser(tokenizer, treeBuilder);

    try {
      return parser.parseTopLevel();
    } catch (exc) {
      console.log("Error occurred at offset " + tokenizer.getPosition());
      console.log("Most recent token was", tokenizer.getPrevious());
      throw exc;
    }
  };


  exports.JsonTreeBuilder = JsonTreeBuilder;
  exports.Tokenizer       = Tokenizer;
  exports.Parser          = Parser;


  exports.parse = parse;
}));