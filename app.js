const express = require('express');
const moment = require('moment');
const app = express();
const port = 3001;
const bodyParser = require('body-parser')
const mongoose = require('mongoose');
const cors = require('cors');
const plaid = require('plaid');
const { PLAID_CLIENT_ID, PLAID_SECRET } = require('./key');
const { response } = require('express');

const client = new plaid.Client({
    clientID: PLAID_CLIENT_ID,
    secret: PLAID_SECRET,
    env: plaid.environments.sandbox
});

app.use(bodyParser.json()) // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())

mongoose.connect('mongodb://localhost:27017/Panorama')

const db = mongoose.connection;
let userSchema = mongoose.Schema({
    email: String,
    password: String,
    items: [
        {
            access_token: String,
            item_id: String
        }
    ],

    assets: [
        {
            asset_type: String,
            asset_icon: Number,
            asset_name: String,
            asset_value: Number,
            _id: false
        }
    ],

    spending_budgets: [
        {
            budget_name: String,
            budget_type: String,
            budget_limit: Number,
            budget_balance: Number,
            associated_accounts: [String],
            _id: false
        }
    ],

    saving_budgets: [
        {
            budget_name: String,
            budget_type: String,
            budget_minimum: Number,
            budget_balance: Number,
            budget_increment: Number,
            date_updated: Date,
            associated_accounts: [String],
            _id: false
        }
    ]

});

let User = mongoose.model('User', userSchema);

db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => {

    app.get('/', (req, res) => {
        res.send('Hello world!!!');
    });

    app.post('/register', (req, res) => {
        let { email, password } = req.body;
        let newUser = new User({ email, password });

        newUser.save((err, user) => { res.send({ message: `User created with ID: ${user._id}` }) });
    });

    app.post('/login', (req, res) => {
        let { email, password } = req.body;
        console.log(req.body);
        User.findOne({ email, password }, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }
            if (doc === null) {
                res.send("")
            } else {
                res.send({ id: doc._id });
            }


        });
    });

    app.post('/create_link_token', (req, res) => {
        let { uid } = req.body;
        console.log(`Recieved: ${uid} as token!!!`);
        User.findById(uid, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }
            let userId = doc._id;

            client.createLinkToken({
                user: {
                    client_user_id: userId
                },
                client_name: 'Panorama',
                products: ['transactions'],
                country_codes: ['US'],
                language: 'en',
                android_package_name: "com.example.panorama"
            }, (err, linkTokenResponse) => {
                res.json({ link_token: linkTokenResponse.link_token });
            });

        });
    });

    app.post('/get_access_token', (req, res) => {
        console.log(req.body);
        let { public_token, uid } = req.body;

        client.exchangePublicToken(public_token, (err, response) => {
            if (err)
                return res.json({ error: "Oops" });

            let { access_token, item_id } = response;

            User.findByIdAndUpdate(uid, { $addToSet: { items: { access_token: access_token, item_id: item_id } } }, (err, data) => {
                console.log("Getting transactions");
                let today = moment().format('YYYY-MM-DD');
                let past = moment().subtract(30, 'days').format('YYYY-MM-DD');
                client.getBalance(access_token, (err, response) => {
                    let liabilities = 0;
                    let netWorth = 0;
                    let cash = 0;
                    let assets = 0;
                    let accounts = response.accounts;
                    accounts.forEach(account => {
                        let currentBalance = account.balances.current;

                        if (account.type == "credit" || account.type == "loan") {
                            currentBalance *= -1;
                            liabilities += currentBalance;
                        } else if (account.type == "depository") {
                            cash += currentBalance;
                            assets += currentBalance;
                        } else {
                            assets += currentBalance;
                        }

                        /*switch (account.type){
                            case "credit" :
                            case "loan" : 
                                currentBalance *= -1;
                                liabilities += currentBalance;
                                break;
                            case "depository" :
                                cash += currentBalance;
                            default :
                                assets += currentBalance;
                        }*/

                        netWorth += currentBalance;
                        account.item_id = response.item.item_id;
                    })

                    res.send({ accounts, liabilities, netWorth, cash, assets });
                    console.log({ accounts, liabilities, netWorth, cash, assets });
                });

            });



        });
    });

    app.post('/transactions', (req, res) => {
        let { uid } = req.body;

        User.findById(uid, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }
            res.send({ transactions: doc.transactions });
        });
    });

    app.post('/accounts', (req, res) => {
        let { uid } = req.body;

        User.findById(uid, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }
            res.send({ accounts: doc.items });
        });
    });

    app.post('/add_asset', (req, res) => {
        console.log(req.body);
        let { uid, asset_type, asset_icon, asset_name, asset_value } = req.body;

        User.findByIdAndUpdate(uid, { $addToSet: { assets: { asset_type: asset_type, asset_icon: asset_icon, asset_name: asset_name, asset_value: asset_value } } }, (err, data) => {
            res.sendStatus(200);
        });
    })

    app.post('/get_balance', (req, res) => {
        let { uid } = req.body;

        let items = [];
        let otherAssets = [];
        let spendingBudgets = [];
        let savingBudgets = [];

        let finalResponse = {
            "accounts": [],
            "other_assets": [],
            "spending_budgets": [],
            "saving_budgets": [],
            "liabilities": 0,
            "netWorth": 0,
            "cash": 0,
            "assets": 0
        }

        User.findById(uid, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }
            items = doc.items;
            otherAssets = doc.assets;
            spendingBudgets = doc.spending_budgets;
            savingBudgets = doc.saving_budgets;

            otherAssets.forEach(otherAsset => {
                if (otherAsset.asset_value < 0) {
                    liabilities += otherAsset.asset_value;
                } else {
                    finalResponse.assets += otherAsset.asset_value;
                }
                finalResponse.netWorth += otherAsset.asset_value;
            })

            spendingBudgets.forEach(spendingBudget => {
                spendingBudget.budget_balance = 0;
            })

            savingBudgets.forEach(savingBudget => {
                savingBudget.budget_balance = 0;
            })

            const myFunc = async () => {
                for (let item of items) {
                    try {
                        await client.getBalance(item.access_token).then(response => {
                            console.log(response);
                            let liabilities = 0;
                            let netWorth = 0;
                            let cash = 0;
                            let assets = 0;
                            let accounts = response.accounts;

                            accounts.forEach(account => {
                                let currentBalance = account.balances.current;

                                if (account.type == "credit" || account.type == "loan") {
                                    currentBalance *= -1;
                                    liabilities += currentBalance;
                                } else if (account.type == "depository") {
                                    cash += currentBalance;
                                    assets += currentBalance;
                                } else {
                                    assets += currentBalance;
                                }

                                spendingBudgets.forEach(spendingBudget => {
                                    if (spendingBudget.associated_accounts.includes(account.account_id)) {
                                        spendingBudget.budget_balance += account.balances.current;
                                    }
                                });

                                

                                savingBudgets.forEach(savingBudget => {
                                    if(savingBudget.associated_accounts.includes(account.account_id)){
                                        savingBudget.budget_balance += account.balances.current;
                                    }
                                });

                                /*switch (account.type){
                                    case "credit" :
                                    case "loan" : 
                                        currentBalance *= -1;
                                        liabilities += currentBalance;
                                        break;
                                    case "depository" :
                                        cash += currentBalance;
                                    default :
                                        assets += currentBalance;
                                }*/

                                netWorth += currentBalance;
                                account.item_id = response.item.item_id;
                            })

                            

                            finalResponse.liabilities += liabilities;
                            finalResponse.netWorth += netWorth;
                            finalResponse.cash += cash;
                            finalResponse.assets += assets;
                            finalResponse.accounts = finalResponse.accounts.concat(accounts);

                        });
                    } catch (e) {
                        console.log(e);
                        if (e.error_code == "ITEM_LOGIN_REQUIRED") {
                            console.log("I'm in the if!");
                        }
                    }
                }

                finalResponse.other_assets = otherAssets;
                finalResponse.spending_budgets = spendingBudgets;
                finalResponse.saving_budgets = savingBudgets;
                console.log(finalResponse);
                res.send(finalResponse);
            }
            myFunc();
        });

    })

    app.post('/get_budgets', (req, res) => {

        let { uid } = req.body;

        let items = [];
        let spendingBudgets = [];
        let savingBudgets = [];

        let finalResponse = {
            "spending_budgets": [],
            "saving_budgets": [],
        }

        User.findById(uid, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }
            items = doc.items;
            spendingBudgets = doc.spending_budgets;
            savingBudgets = doc.savingBudgets;

            spendingBudgets.forEach(spendingBudget => {
                spendingBudget.budget_balance = 0;
            })

            /* savingBudgets.forEach(savingBudget => {
                savingBudget.budget_balance = 0;
            }) */

            const myFunc = async () => {
                for (let item of items) {
                    await client.getAccounts(item.access_token).then(response => {
                        let accounts = response.accounts;

                        accounts.forEach(account => {

                            spendingBudgets.forEach(spendingBudget => {
                                if (spendingBudget.associated_accounts.includes(account.account_id)) {
                                    spendingBudget.budget_balance += account.balances.current;
                                }
                            })

                            savingBudgets.forEach(savingBudget => {
                                if(savingBudget.associated_accounts.includes(account.account_id)){
                                    savingBudget.budget_balance += account.balances.current;
                                }
                            })
                        })

                        finalResponse.spending_budgets = spendingBudgets;
                        finalResponse.saving_budgets = savingBudgets;

                    });
                }
                console.log(finalResponse);
                res.send(finalResponse);
            }
            myFunc();
        });
    })

    app.post('/add_budget', (req, res) => {

        let { uid, budget_name, budget_type, budget_limit, associated_accounts } = req.body;
        console.log(req.body);

        if (budget_type == "spending") {
            User.findByIdAndUpdate(uid, { $addToSet: { spending_budgets: { budget_name: budget_name, budget_type: budget_type, budget_limit: budget_limit, associated_accounts: associated_accounts } } }, (err, data) => {
                res.send(200);
            });
        } else {
            User.findByIdAndUpdate(uid, { $addToSet: { saving_budgets: { budget_name: budget_name, budget_type: budget_type, budget_limit: budget_limit, associated_accounts: associated_accounts } } }, (err, data) => {
                res.send(200);
            });
        }
    })

    app.post('/get_transactions', (req, res) => {

        let { uid, account_id, item_id } = req.body;

        console.log(uid, account_id, item_id);


        User.findById(uid, (err, doc) => {
            if (err) {
                res.sendStatus(400);
                return;
            }

            let items = doc.items;
            let item = items.find(item => item.item_id == item_id);
            console.log(items);

            let access_token = items.find(item => item.item_id == item_id).access_token;
            console.log(uid);
            console.log(account_id);
            console.log(item_id);
            console.log(access_token);
            let today = moment().format('YYYY-MM-DD');
            let past = moment().subtract(30, 'days').format('YYYY-MM-DD');
            console.log(today);
            console.log(past);

            let options = { "account_ids": [account_id] };
            console.log(options);

            client.getTransactions(access_token, past, today, options).then(response => {
                res.send(response);
            });
        });
    })

    app.listen(port, "192.168.1.179" || "localhost", () => {
        console.log(`listening to requests on http://localhost:${port}`);
    })

});