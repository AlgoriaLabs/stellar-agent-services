// verifier CLI. Planned usage:
//
//   check <manifest-url> [--dev]      C1, C3, C6 and C7 with no payment. --dev also accepts a local http://
//                                     server, so any provider, in any language, can test itself first
//   verify <manifest-url> [--pay]     all checks C1–C7 (C4, C5 and C7's paid part need --pay and a funded test payer)
//   publish <receipt.json>            validation_response for a pending validation_request
//   badge <receipt.json>              write SVG badges next to the receipt
//
// The `bin` entry is added to package.json once the first command exists.

export {};
