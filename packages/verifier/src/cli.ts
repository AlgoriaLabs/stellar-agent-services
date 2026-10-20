// verifier CLI. Planned usage:
//
//   check <manifest-url>              C1, C3 and C6 with no payment; works against localhost, so any
//                                     provider, in any language, can test itself before going live
//   verify <manifest-url> [--pay]     all checks C1–C6 (C4 and C5 need --pay and a funded test payer)
//   publish <receipt.json>            validation_response for a pending validation_request
//   badge <receipt.json>              write SVG badges next to the receipt
//
// The `bin` entry is added to package.json once the first command exists.

export {};
