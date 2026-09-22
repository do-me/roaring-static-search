const TOKEN = /[\p{L}\p{N}\p{Co}]+/gu;
const AT_TOKEN = /^[\p{L}\p{N}\p{Co}]+/u;

export function normalize(value) {
  return value.toLowerCase();
}

export function textTokens(value) {
  return [...normalize(value).matchAll(TOKEN)].map((match) => match[0]);
}

function lex(input) {
  const result = [];
  for (let position = 0; position < input.length;) {
    const rest = input.slice(position);
    if (/^\s/u.test(rest)) { position++; continue; }
    const char = input[position];
    if (char === "(" || char === ")") { result.push({ type: char }); position++; continue; }
    if (char === '"') {
      let end = position + 1;
      let phrase = "";
      while (end < input.length && input[end] !== '"') {
        if (input[end] === "\\" && end + 1 < input.length) end++;
        phrase += input[end++];
      }
      if (end >= input.length) throw new SyntaxError("Unclosed quoted phrase");
      const words = textTokens(phrase);
      if (!words.length) throw new SyntaxError("Empty quoted phrase");
      result.push(words.length === 1 ? { type: "term", term: words[0] } : { type: "phrase", terms: words });
      position = end + 1;
      continue;
    }
    const word = AT_TOKEN.exec(rest)?.[0];
    if (!word) throw new SyntaxError(`Unexpected character at position ${position}: ${char}`);
    const normalized = normalize(word);
    result.push(normalized === "and" || normalized === "or"
      ? { type: normalized.toUpperCase() }
      : { type: "term", term: normalized });
    position += word.length;
  }
  return result;
}

export function parseQuery(input) {
  const tokens = lex(input);
  let index = 0;
  function primary() {
    const token = tokens[index++];
    if (!token) throw new SyntaxError("Expected a term or parenthesized expression");
    if (token.type === "term" || token.type === "phrase") return token;
    if (token.type === "(") {
      const inner = orExpression();
      if (tokens[index++]?.type !== ")") throw new SyntaxError("Expected closing parenthesis");
      return inner;
    }
    throw new SyntaxError(`Unexpected ${token.type}`);
  }
  function andExpression() {
    let left = primary();
    while (tokens[index]?.type === "AND") { index++; left = { type: "AND", left, right: primary() }; }
    return left;
  }
  function orExpression() {
    let left = andExpression();
    while (tokens[index]?.type === "OR") { index++; left = { type: "OR", left, right: andExpression() }; }
    return left;
  }
  if (!tokens.length) throw new SyntaxError("Empty query");
  const tree = orExpression();
  if (index !== tokens.length) throw new SyntaxError(`Unexpected ${tokens[index].type}`);
  return tree;
}

export function queryTerms(tree) {
  const result = new Set();
  let hasPhrase = false;
  function visit(node) {
    if (node.type === "term") result.add(node.term);
    else if (node.type === "phrase") { hasPhrase = true; node.terms.forEach((term) => result.add(term)); }
    else { visit(node.left); visit(node.right); }
  }
  visit(tree);
  return { terms: [...result], hasPhrase };
}

function containsPhrase(words, phrase) {
  outer: for (let i = 0; i <= words.length - phrase.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (words[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

export function matchesText(tree, text) {
  const words = textTokens(text);
  const set = new Set(words);
  function evalNode(node) {
    if (node.type === "term") return set.has(node.term);
    if (node.type === "phrase") return containsPhrase(words, node.terms);
    if (node.type === "AND") return evalNode(node.left) && evalNode(node.right);
    return evalNode(node.left) || evalNode(node.right);
  }
  return evalNode(tree);
}
