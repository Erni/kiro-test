# Requirements Document

## Introduction

This feature establishes the core functionality of the kiro-test web application: managing a portfolio of cryptoassets. It covers creating and maintaining cryptoasset holdings, recording buy/sell transactions against those holdings, viewing the current composition and value of the portfolio, and persisting portfolio data between sessions. This feature is the foundational building block for the application and is intended to serve as a reference implementation of Kiro best practices.

## Glossary

- **System**: The kiro-test web application backend and business logic that processes portfolio operations.
- **Portfolio**: The collection of all Holdings belonging to the user.
- **Cryptoasset**: A distinct cryptocurrency identified by a unique symbol (e.g., BTC, ETH) and a display name.
- **Holding**: A record within the Portfolio representing the quantity of a specific Cryptoasset currently owned and its associated Current_Price.
- **Transaction**: A record of a single buy or sell event for a Cryptoasset, including Transaction_Type, quantity, price per unit, and timestamp.
- **Transaction_Type**: The classification of a Transaction, with allowed values "Buy" or "Sell".
- **Current_Price**: The price per unit of a Cryptoasset, expressed in the Portfolio's reference currency, as entered or last updated by the user.
- **Holding_Value**: The product of a Holding's quantity and its Current_Price.
- **Portfolio_Value**: The sum of the Holding_Value of every Holding in the Portfolio.
- **Reference_Currency**: The fiat currency (e.g., USD) in which prices and values are expressed.

## Requirements

### Requirement 1: Manage Cryptoasset Holdings

**User Story:** As a portfolio owner, I want to add, edit, and remove cryptoasset holdings, so that my portfolio reflects the cryptoassets I actually own.

#### Acceptance Criteria

1. WHEN a user submits a new Holding with a Cryptoasset symbol of 1 to 10 characters using uppercase letters and digits, a quantity greater than 0 and up to 1,000,000,000,000 (with up to 8 decimal places), and a Current_Price of 0 up to 1,000,000,000,000 (with up to 8 decimal places), THE System SHALL create a Holding in the Portfolio.
2. IF a user submits a new Holding with a Cryptoasset symbol that already exists in the Portfolio, THEN THE System SHALL reject the submission and return an error indicating the Cryptoasset is already held.
3. IF a user submits a new Holding with a quantity less than or equal to zero or greater than 1,000,000,000,000, THEN THE System SHALL reject the submission and return a validation error.
4. IF a user submits a new Holding with a Current_Price less than zero or greater than 1,000,000,000,000, THEN THE System SHALL reject the submission and return a validation error.
5. WHEN a user submits an update to an existing Holding's quantity or Current_Price within the valid ranges defined for Holding creation, THE System SHALL update the Holding with the submitted values.
6. IF a user submits an update to a Holding with a quantity less than or equal to zero or greater than 1,000,000,000,000, or a Current_Price less than zero or greater than 1,000,000,000,000, THEN THE System SHALL reject the update and return a validation error.
7. WHEN a user requests removal of a Holding, THE System SHALL delete the Holding and its associated Transactions from the Portfolio.
8. WHEN a user requests the list of Holdings, THE System SHALL return every Holding currently in the Portfolio, or an empty list if the Portfolio contains no Holdings.
9. IF a user submits an update for a Cryptoasset symbol with no existing Holding in the Portfolio, THEN THE System SHALL reject the update and return an error indicating the Holding does not exist.
10. IF a user requests removal of a Holding for a Cryptoasset symbol with no existing Holding in the Portfolio, THEN THE System SHALL reject the removal and return an error indicating the Holding does not exist.
11. IF a user submits a new Holding with a Cryptoasset symbol that is empty, exceeds 10 characters, or contains characters other than uppercase letters and digits, THEN THE System SHALL reject the submission and return a validation error.

### Requirement 2: Record Cryptoasset Transactions

**User Story:** As a portfolio owner, I want to record buy and sell transactions for my cryptoassets, so that I have an accurate history of how my holdings changed over time.

#### Acceptance Criteria

1. WHEN a user submits a Transaction with a Cryptoasset symbol, a Transaction_Type of "Buy", a quantity greater than zero, and a price per unit greater than or equal to zero, THE System SHALL record the Transaction and increase the corresponding Holding's quantity by the Transaction's quantity.
2. WHEN a user submits a Transaction with a Cryptoasset symbol, a Transaction_Type of "Sell", a quantity greater than zero, and a price per unit greater than or equal to zero, THE System SHALL record the Transaction and decrease the corresponding Holding's quantity by the Transaction's quantity.
3. IF a user submits a "Buy" Transaction for a Cryptoasset with no existing Holding, THEN THE System SHALL create a new Holding for that Cryptoasset with a quantity equal to the Transaction's quantity and a Current_Price equal to the Transaction's price per unit.
4. IF a user submits a "Sell" Transaction for a Cryptoasset with no existing Holding, or with a quantity greater than the corresponding Holding's current quantity, THEN THE System SHALL reject the Transaction and return an error indicating insufficient quantity.
5. IF a user submits a Transaction with a Transaction_Type other than "Buy" or "Sell", THEN THE System SHALL reject the Transaction and return a validation error.
6. IF a user submits a Transaction with a quantity less than or equal to zero, or a price per unit less than zero, THEN THE System SHALL reject the Transaction and return a validation error.
7. WHEN a "Sell" Transaction reduces a Holding's quantity to zero, THE System SHALL remove the Holding from the Portfolio while retaining its associated Transactions for future Transaction history requests.
8. WHEN a user requests the Transaction history for a Cryptoasset, THE System SHALL return every Transaction recorded for that Cryptoasset, including Transactions for Holdings previously removed due to a zero quantity, ordered by timestamp from earliest to latest.
9. WHEN a Transaction is recorded, THE System SHALL assign it a timestamp reflecting the date and time at which the Transaction was recorded.

### Requirement 3: View Portfolio Overview and Value

**User Story:** As a portfolio owner, I want to see the current value of my portfolio and each holding, so that I can understand how my investments are performing.

#### Acceptance Criteria

1. WHEN a user requests the Portfolio overview, THE System SHALL return every Holding together with its Cryptoasset symbol, quantity, Current_Price, and Holding_Value, with Current_Price and Holding_Value expressed in the Portfolio's Reference_Currency.
2. WHEN a user requests the Portfolio overview, THE System SHALL return the Portfolio_Value, expressed in the Portfolio's Reference_Currency, calculated as the sum of the Holding_Value of every Holding.
3. WHEN a user requests the Portfolio overview, IF the Portfolio contains no Holdings, THEN THE System SHALL return an empty list of Holdings and a Portfolio_Value of zero.
4. WHEN a user requests the Portfolio overview, THE System SHALL calculate each returned Holding's Holding_Value and the Portfolio_Value using that Holding's quantity and Current_Price as of the time of the request.

### Requirement 4: Update Cryptoasset Prices

**User Story:** As a portfolio owner, I want to update the current price of a cryptoasset I hold, so that my portfolio value reflects up-to-date market conditions.

#### Acceptance Criteria

1. WHEN a user submits an updated Current_Price for a Cryptoasset with an existing Holding, THE System SHALL update the Holding's Current_Price to the submitted value without changing the Holding's quantity.
2. IF a user submits an update with a Current_Price that is missing, non-numeric, or less than zero, THEN THE System SHALL reject the update, leave the Holding's existing Current_Price unchanged, and return a validation error.
3. IF a user submits an updated Current_Price for a Cryptoasset with no existing Holding, THEN THE System SHALL reject the update and return an error indicating the Holding does not exist.

### Requirement 5: Persist Portfolio Data

**User Story:** As a portfolio owner, I want my holdings and transaction history to be saved, so that my data is available when I return to the application.

#### Acceptance Criteria

1. WHEN a Holding is created, updated, or removed, THE System SHALL persist the change before confirming the operation to the user.
2. WHEN a Transaction is recorded, THE System SHALL persist the Transaction and the resulting Holding change, including creation or removal of the Holding, before confirming the operation to the user.
3. WHEN the application starts, THE System SHALL load the previously persisted Portfolio, including all Holdings and Transactions.
4. IF the System fails to persist a change, THEN THE System SHALL return an error, SHALL NOT report the operation as successful, and SHALL leave the Portfolio's persisted and in-memory state as it was immediately before the change was attempted.
5. IF no Portfolio data has been previously persisted when the application starts, THEN THE System SHALL initialize an empty Portfolio containing zero Holdings and zero Transactions.
6. IF the System is unable to load the persisted Portfolio data when the application starts, THEN THE System SHALL report a startup error and SHALL NOT present a Portfolio to the user until the error is resolved.
