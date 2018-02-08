const fetch = require('isomorphic-fetch');

const BINANCE_TICKER_URL = 'https://api.binance.com/api/v1/ticker/allPrices';
const BINANCE_DEPTH_URL = 'https://api.binance.com/api/v1/depth?symbol=EOSETH&limit=500';    

class BinanceProvider {
    constructor() {
        this.providerName = 'binance';
    }

    async watch() {
        const marketPrice = await this.getPrice();
        const marketDepth = await this.getVolume(currentMarketPrice);

        return {
            marketPrice,
            marketDepth,
        };
    }

    getPrice() {
        return fetch(BINANCE_TICKER_URL)
            .then(res => res.json())
            .then(market => market.find((entry) => entry.symbol === 'EOSETH'))
            .then(entry => parseFloat(entry.price))
            .catch(e => console.log(`${this.providerName} error: could not fetch market price`));
    }

    getVolume(price) {
        return fetch(BINANCE_DEPTH_URL)
            .then(res => res.json())
            .then(res => res.bids.reduce((a, v) => {
                v[0] = parseFloat(v[0]);
                v[1] = parseFloat(v[1]);

                if(v[0] >= price) {
                    a += v[0] * v[1];
                }

                return a;
            }, 0))
            .then(vol => vol.toFixed(0))
            .catch(e => console.log(`${this.providerName} error: could not fetch market depth`));
    }
}

module.exports = BinanceProvider;
