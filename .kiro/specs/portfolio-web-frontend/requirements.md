# Requirements Document

## Introduction

This feature adds a simple web-based frontend to the kiro-test application, giving a portfolio owner a browser-based way to use the existing portfolio management REST API (delivered by the `crypto-portfolio-core` feature) instead of calling it directly. The frontend covers the basic operations already exposed by that API: viewing the portfolio overview, managing holdings (add, edit, remove), recording buy/sell transactions, viewing transaction history for a cryptoasset, and updating a holding's price. This feature is intentionally scoped to basic functionality; it does not introduce new business logic, authentication, or capabilities beyond what the backend API already supports.

## Glossary

- **Frontend**: The web-based user interface delivered by this feature, which allows a user to view and manage a Portfolio through a web browser.
- **Backend_API**: The existing REST API, implemented by the `crypto-portfolio-core` feature, that stores and manages Portfolio data on behalf of the Frontend.
- **Portfolio**: The collection of all Holdings belonging to the user, as maintained by the Backend_API.
- **Cryptoasset**: A distinct cryptocurrency identified by a unique symbol (e.g., BTC, ETH) and a display name.
- **Holding**: A record representing the quantity of a specific Cryptoasset currently owned and its associated Current_Price, as returned by the Backend_API.
- **Transaction**: A record of a single buy or sell event for a Cryptoasset, including Transaction_Type, quantity, price per unit, and timestamp.
- **Transaction_Type**: The classification of a Transaction, with allowed values "Buy" or "Sell".
- **Current_Price**: The price per unit of a Cryptoasset, expressed in the Portfolio's Reference_Currency, as returned by or submitted to the Backend_API.
- **Holding_Value**: The product of a Holding's quantity and its Current_Price.
- **Portfolio_Value**: The sum of the Holding_Value of every Holding in the Portfolio.
- **Reference_Currency**: The fiat currency (e.g., USD) in which prices and values are expressed.
- **Holdings_List**: The Frontend view that displays every Holding currently in the Portfolio.
- **Portfolio_Overview_View**: The Frontend view that displays the Holdings_List together with each Holding's Holding_Value and the Portfolio_Value.
- **Cryptoasset_Selection_List**: A fixed, ordered list of the 15 Cryptoassets with the largest market capitalization, ranked from largest to smallest according to CoinMarketCap, from which a user chooses a Cryptoasset symbol when adding a Holding or recording a Transaction.

## Requirements

### Requirement 1: View Portfolio Overview

**User Story:** As a portfolio owner, I want to view my portfolio overview in a web browser, so that I can see my current holdings and their value without calling the Backend_API directly.

#### Acceptance Criteria

1. WHEN a user opens the Portfolio_Overview_View, THE Frontend SHALL request the Portfolio overview from the Backend_API.
2. WHEN the Backend_API returns a successful Portfolio overview response, THE Frontend SHALL display, for every returned Holding and regardless of the order in which the Backend_API returns them, its Cryptoasset symbol, quantity, Current_Price, and Holding_Value.
3. WHEN the Backend_API returns a successful Portfolio overview response, THE Frontend SHALL display the returned Portfolio_Value.
4. IF the Backend_API returns a successful Portfolio overview response containing no Holdings, THEN THE Frontend SHALL display an indication that the Portfolio has no Holdings and a Portfolio_Value of zero.
5. IF the Backend_API returns an error response to the Portfolio overview request, THEN THE Frontend SHALL display an error message indicating that the Portfolio overview could not be loaded.

### Requirement 2: Add a Holding

**User Story:** As a portfolio owner, I want to add a new holding through the web interface, so that I can start tracking a cryptoasset without calling the Backend_API directly.

#### Acceptance Criteria

1. THE Frontend SHALL provide a form for selecting a Cryptoasset symbol from the Cryptoasset_Selection_List and submitting a quantity and Current_Price to create a new Holding, requiring a value for each of the three fields before the form can be submitted.
2. WHEN a user submits the new Holding form, THE Frontend SHALL send a request to the Backend_API to create the Holding with the submitted values.
3. WHEN the Backend_API confirms creation of a new Holding, THE Frontend SHALL display the created Holding in the Holdings_List.
4. IF the Backend_API rejects the new Holding submission, THEN THE Frontend SHALL display the error message returned by the Backend_API to the user.
5. WHEN the Backend_API confirms creation of a new Holding, THE Frontend SHALL clear the new Holding form.
6. IF the Backend_API rejects the new Holding submission, THEN THE Frontend SHALL retain the values previously entered in the new Holding form.

### Requirement 3: Edit a Holding

**User Story:** As a portfolio owner, I want to edit an existing holding's quantity and price through the web interface, so that I can correct or update my holdings.

#### Acceptance Criteria

1. THE Frontend SHALL provide, for each Holding displayed in the Holdings_List, a control that opens an update form for submitting a revised quantity and Current_Price for that Holding.
2. WHEN a user opens the update form for a Holding, THE Frontend SHALL pre-populate the quantity field with that Holding's current quantity and the Current_Price field with that Holding's current Current_Price.
3. WHEN a user submits the update Holding form, THE Frontend SHALL send a request to the Backend_API to update the Holding identified by its Cryptoasset symbol with the submitted quantity and Current_Price values.
4. WHEN the Backend_API confirms the Holding update, THE Frontend SHALL display the updated quantity and Current_Price for that Holding in the Holdings_List and close the update form.
5. IF the Backend_API rejects the Holding update, THEN THE Frontend SHALL display the error message returned by the Backend_API to the user and retain the update form open with the quantity and Current_Price values the user submitted.

### Requirement 4: Remove a Holding

**User Story:** As a portfolio owner, I want to remove a holding through the web interface, so that I can stop tracking a cryptoasset I no longer own.

#### Acceptance Criteria

1. THE Frontend SHALL provide, for each Holding displayed in the Holdings_List, a control for requesting removal of that Holding.
2. WHEN a user requests removal of a Holding, THE Frontend SHALL request confirmation from the user, identifying the Cryptoasset symbol of the Holding to be removed, before sending a deletion request to the Backend_API.
3. WHEN a user confirms removal of a Holding, THE Frontend SHALL send a request to the Backend_API to delete the Holding.
4. WHEN a user declines the removal confirmation, THE Frontend SHALL leave the Holding unchanged in the Holdings_List and SHALL NOT send a deletion request to the Backend_API.
5. WHEN the Backend_API confirms deletion of a Holding, THE Frontend SHALL remove the Holding from the Holdings_List.
6. IF the Backend_API rejects the Holding removal, THEN THE Frontend SHALL display the error message returned by the Backend_API to the user.

### Requirement 5: Record a Transaction

**User Story:** As a portfolio owner, I want to record buy and sell transactions through the web interface, so that I can track my trading activity.

#### Acceptance Criteria

1. THE Frontend SHALL provide a form for selecting a Cryptoasset symbol from the Cryptoasset_Selection_List and submitting a Transaction_Type, quantity, and price per unit to record a Transaction.
2. WHEN a user submits the Transaction form, THE Frontend SHALL send a request to the Backend_API to record the Transaction with the submitted values.
3. WHEN the Backend_API confirms a recorded Transaction, THE Frontend SHALL display a confirmation showing the recorded Transaction's Cryptoasset symbol, Transaction_Type, quantity, and price per unit.
4. WHEN the Backend_API confirms a recorded Transaction, THE Frontend SHALL refresh the Holdings_List to reflect the resulting Holding quantity for that Cryptoasset.
5. IF a Sell Transaction reduces a Holding's quantity to zero, THEN THE Frontend SHALL update the Holdings_List so that the Holding no longer appears, consistent with the Backend_API removing the Holding.
6. IF the Backend_API rejects the Transaction submission, THEN THE Frontend SHALL display the error message returned by the Backend_API to the user.

### Requirement 6: View Transaction History

**User Story:** As a portfolio owner, I want to view the transaction history for a cryptoasset, so that I can review past buy and sell activity.

#### Acceptance Criteria

1. THE Frontend SHALL provide a control for specifying a Cryptoasset symbol, including symbols for which the Portfolio has no current Holding, for which to request Transaction history.
2. WHEN a user requests the Transaction history for the specified Cryptoasset symbol, THE Frontend SHALL request the Transaction history from the Backend_API and display every returned Transaction's Transaction_Type, quantity, price per unit, and timestamp, ordered from earliest to latest.
3. IF the Backend_API returns no Transactions for the specified Cryptoasset symbol, THEN THE Frontend SHALL display an indication that no Transactions exist for that symbol.
4. IF the request to the Backend_API for Transaction history fails, THEN THE Frontend SHALL display an error message indicating that the Transaction history could not be loaded.

### Requirement 7: Update a Holding's Price

**User Story:** As a portfolio owner, I want to update the current price of a cryptoasset through the web interface, so that my portfolio value reflects up-to-date market conditions.

#### Acceptance Criteria

1. THE Frontend SHALL provide, for each Holding displayed in the Holdings_List, a control for submitting an updated Current_Price for that Holding.
2. WHEN a user submits an updated Current_Price using a Holding's control, THE Frontend SHALL send a request to the Backend_API to update that Holding's price with the submitted value.
3. WHEN the Backend_API confirms the price update, THE Frontend SHALL display the updated Current_Price and the recalculated Holding_Value for that Holding in the Holdings_List.
4. WHEN the Backend_API confirms the price update, THE Frontend SHALL update the displayed Portfolio_Value to reflect the recalculated Holding_Value.
5. IF the Backend_API rejects the price update, THEN THE Frontend SHALL display the error message returned by the Backend_API to the user.

### Requirement 8: Provide Feedback During Backend Communication

**User Story:** As a portfolio owner, I want to see when the web interface is working or cannot reach the backend, so that I understand the current state of my request.

#### Acceptance Criteria

1. WHILE a request to the Backend_API is in progress, THE Frontend SHALL display a loading indicator that is visible to the user for the duration of that request.
2. WHEN a request to the Backend_API completes, whether the response indicates success or failure, THE Frontend SHALL remove the loading indicator.
3. IF a request to the Backend_API fails because no response is received within a 30 second timeout or because the network connection is unavailable, THEN THE Frontend SHALL display a message indicating that the Backend_API could not be reached, in addition to, and without replacing, any view-specific error message required by other requirements in this document.

### Requirement 9: Select a Cryptoasset from a Predefined List

**User Story:** As a portfolio owner, I want to choose a cryptoasset from a list of well-known cryptocurrencies when adding a holding or recording a transaction, so that I don't have to remember or type exact symbols.

#### Acceptance Criteria

1. THE Frontend SHALL maintain a Cryptoasset_Selection_List consisting of exactly the following 15 Cryptoassets, in this order (largest to smallest market capitalization per CoinMarketCap at the time this requirement was written): Bitcoin (BTC), Ethereum (ETH), Tether (USDT), BNB (BNB), XRP (XRP), USDC (USDC), Solana (SOL), TRON (TRX), Hyperliquid (HYPE), Zcash (ZEC), Dogecoin (DOGE), Monero (XMR), Chainlink (LINK), UNUS SED LEO (LEO), Cardano (ADA).
2. THE Frontend SHALL use the Cryptoasset_Selection_List as the sole means of selecting a Cryptoasset symbol in the new Holding form and in the Transaction form.
3. WHEN a user opens the Cryptoasset selection control in the new Holding form or the Transaction form, THE Frontend SHALL present the entries of the Cryptoasset_Selection_List in their defined order.
4. THE Frontend SHALL display, for each entry in the Cryptoasset_Selection_List, both the Cryptoasset's symbol and its display name.
5. THE Frontend SHALL submit the selected entry's symbol as the Cryptoasset symbol value when the new Holding form or the Transaction form is submitted.
