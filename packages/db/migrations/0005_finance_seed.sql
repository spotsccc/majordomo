INSERT INTO "finance"."currencies" ("code", "name", "kind", "scale", "rate_source", "rate_id") VALUES
	('RUB', 'Российский рубль', 'fiat', 2, 'fiat', NULL),
	('USD', 'Доллар США', 'fiat', 2, 'fiat', NULL),
	('ARS', 'Аргентинское песо', 'fiat', 2, 'fiat', NULL),
	('GEL', 'Грузинский лари', 'fiat', 2, 'fiat', NULL),
	('USDT', 'Tether', 'crypto', 6, 'coin', 'tether'),
	('USDC', 'USD Coin', 'crypto', 6, 'coin', 'usd-coin'),
	('BTC', 'Bitcoin', 'crypto', 8, 'coin', 'bitcoin'),
	('ETH', 'Ethereum', 'crypto', 18, 'coin', 'ethereum');
--> statement-breakpoint
INSERT INTO "finance"."categories" ("name") VALUES
	('Продукты'),
	('Кафе и рестораны'),
	('Транспорт'),
	('Жильё'),
	('Связь и подписки'),
	('Здоровье'),
	('Одежда'),
	('Развлечения'),
	('Путешествия'),
	('Подарки'),
	('Прочее');
