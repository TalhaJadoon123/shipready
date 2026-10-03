# GHG Emissions Calculation Worksheet — <<COMPANY_TRADING_NAME>>

**Entity:** <<COMPANY_LEGAL_NAME>>
**Reference:** ESRS E1, GHG Protocol Corporate Standard
**Reporting period:** <<REPORTING_PERIOD>>

---

## 1. Method and boundary

- **Standard:** <<GHG_METHOD>>
- **Organisational boundary:** <<GHG_BOUNDARY>>
- **Operational boundary:** <<OPERATIONAL_BOUNDARY>>
- **Consolidation approach:** Equity share / operational control — <<CONSOLIDATION_APPROACH>>
- **Base year:** <<BASE_YEAR>> at <<BASE_YEAR_TONNES>> tCO₂e
- **Target:** <<CLIMATE_TARGET>>

**Greenhouse gases covered:** CO₂, CH₄, N₂O, HFCs, PFCs, SF₆, NF₃.
**GWP basis:** <<GWP_BASIS>>

---

## 2. Scope 1 — Direct emissions

Emissions from sources the company owns or controls.

| Source | Data | Activity data | Unit | Factor | Unit factor | tCO₂e |
| --- | --- | --- | --- | --- | --- | --- |
| Natural gas combustion (heating) | Metered | <<GAS_ACTIVITY>> | kWh | Supplier factor <<GAS_FACTOR>> | kgCO₂e/kWh | <<GAS_TCO2E>> |
| Company vehicles | Fuel card | <<VEHICLE_ACTIVITY>> | litres | <<VEHICLE_FACTOR>> | kgCO₂e/l | <<VEHICLE_TCO2E>> |
| Refrigerants (leakage) | Engineer estimate | <<REFRIGERANT_KG>> | kg | GWP <<REFRIGERANT_GWP>> | kgCO₂e/kg | <<REFRIGERANT_TCO2E>> |
| **Scope 1 total** | | | | | | **<<SCOPE1_TOTAL>>** |

Data quality: <<GAS_DATA_QUALITY>>. Estimation method where metered data is
unavailable: <<GAS_ESTIMATION_METHOD>>.

---

## 3. Scope 2 — Indirect energy emissions

Emissions from purchased electricity, steam, heat and cooling.

### 3.1 Location-based

| Source | Activity data | Unit | Factor | Unit factor | tCO₂e |
| --- | --- | --- | --- | --- | --- |
| Electricity — office | Metered | <<OFFICE_ELEC_ACTIVITY>> kWh | Grid factor, <<OFFICE_ELEC_REGION>> | <<OFFICE_ELEC_FACTOR>> kgCO₂e/kWh | <<OFFICE_ELEC_TCO2E>> |
| Electricity — hosting region | Attributable share | <<HOSTING_ELEC_ACTIVITY>> kWh | Grid factor, <<HOSTING_ELEC_REGION>> | <<HOSTING_ELEC_FACTOR>> kgCO₂e/kWh | <<HOSTING_ELEC_TCO2E>> |
| **Scope 2 location-based total** | | | | | **<<SCOPE2_LOCATION_TOTAL>>** |

### 3.2 Market-based

| Source | Instrument | % covered | tCO₂e |
| --- | --- | --- | --- |
| Electricity — office | <<OFFICE_INSTRUMENT>> | <<OFFICE_INSTRUMENT_PCT>> | <<OFFICE_MB_TCO2E>> |
| Electricity — hosting region | <<HOSTING_INSTRUMENT>> | <<HOSTING_INSTRUMENT_PCT>> | <<HOSTING_MB_TCO2E>> |
| **Scope 2 market-based total** | | | **<<SCOPE2_MARKET_TOTAL>>** |

---

## 4. Scope 3 — Other indirect emissions

Material categories only. Screening follows the GHG Protocol Scope 3 guidance.

| Category | Material? | Method | Data quality | tCO₂e |
| --- | --- | --- | --- | --- |
| 1 Purchased goods and services | <<S3_1_MATERIAL>> | Spend-based | <<S3_1_QUALITY>> | <<S3_1_TCO2E>> |
| 2 Capital goods | <<S3_2_MATERIAL>> | Spend-based | <<S3_2_QUALITY>> | <<S3_2_TCO2E>> |
| 3 Fuel and energy | <<S3_3_MATERIAL>> | Spend-based | <<S3_3_QUALITY>> | <<S3_3_TCO2E>> |
| 4 Upstream transport | <<S3_4_MATERIAL>> | Not estimated | — | 0 |
| 5 Waste | <<S3_5_MATERIAL>> | Spend-based | <<S3_5_QUALITY>> | <<S3_5_TCO2E>> |
| 6 Business travel | <<S3_6_MATERIAL>> | Distance-based | <<S3_6_QUALITY>> | <<S3_6_TCO2E>> |
| 7 Employee commuting | <<S3_7_MATERIAL>> | Survey-based | <<S3_7_QUALITY>> | <<S3_7_TCO2E>> |
| 8 Upstream leased assets | <<S3_8_MATERIAL>> | Floor area × factor | <<S3_8_QUALITY>> | <<S3_8_TCO2E>> |
| 9 Downstream transportation | Not relevant | — | — | 0 |
| 10-12 Use of sold products | Not relevant | — | — | 0 |
| 13-15 End of life, franchised, investments | <<S3_13_MATERIAL>> | <<S3_13_METHOD>> | <<S3_13_QUALITY>> | <<S3_13_TCO2E>> |
| **Scope 3 total (material categories)** | | | | **<<SCOPE3_TOTAL>>** |

AI model inference is counted under **Category 1 (purchased services)**, not as a
separate category, with a note disclosing that it is a material driver of our
emissions given our business model. Some companies report it separately under
Category 11; either is defensible provided it is consistent and explained.

---

## 5. Totals

| Scope | tCO₂e |
| --- | --- |
| Scope 1 | <<SCOPE1_TOTAL>> |
| Scope 2 (location-based) | <<SCOPE2_LOCATION_TOTAL>> |
| Scope 2 (market-based) | <<SCOPE2_MARKET_TOTAL>> |
| Scope 3 (material categories) | <<SCOPE3_TOTAL>> |
| **Total (location-based)** | **<<TOTAL_LOCATION>>** |
| **Total (market-based)** | **<<TOTAL_MARKET>>** |

Change against base year: <<CHANGE_VS_BASE_YEAR>>

---

## 6. Data quality summary

| Scope | Proportion from primary data | Proportion from specific factors | Proportion estimated |
| --- | --- | --- | --- |
| Scope 1 | <<Q1_PRIMARY>> | <<Q1_SPECIFIC>> | <<Q1_ESTIMATED>> |
| Scope 2 | <<Q2_PRIMARY>> | <<Q2_SPECIFIC>> | <<Q2_ESTIMATED>> |
| Scope 3 | <<Q3_PRIMARY>> | <<Q3_SPECIFIC>> | <<Q3_ESTIMATED>> |

Limitations and their effect on comparability: <<LIMITATIONS>>

---

## 7. Climate transition plan

<<CLIMATE_TRANSITION_PLAN>>

Actions planned, with the lever and the expected effect:

| Action | Lever | Expected tCO₂e reduction | Cost | By when |
| --- | --- | --- | --- | --- |
| <<TRANSITION_ACTION>> | <<TRANSITION_LEVER>> | <<TRANSITION_REDUCTION>> | <<TRANSITION_COST>> | <<TRANSITION_WHEN>> |

---

*Generated by ShipReady. Figures must be sourced and auditable before external
reporting. A number without a stated method is not a disclosure.*