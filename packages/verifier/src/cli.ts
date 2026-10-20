// verifier CLI. Planned usage:
//
//   verify <manifest-url> [--pay]      run checks C1–C6 (C4 and C5 need --pay and a funded test payer)
//   publish <receipt.json>             validation_response for a pending validation_request
//   badge <receipt.json>               write SVG badges next to the receipt
//
// The `bin` entry is added to package.json once the first command exists.

export {};
