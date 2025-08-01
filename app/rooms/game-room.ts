import { Dispatcher } from "@colyseus/command"
import { MapSchema } from "@colyseus/schema"
import { Client, Room } from "colyseus"
import admin from "firebase-admin"
import { nanoid } from "nanoid"
import { computeElo } from "../core/elo"
import { CountEvolutionRule, ItemEvolutionRule } from "../core/evolution-rules"
import { MiniGame } from "../core/mini-game"
import {
  clearPendingGame,
  clearPendingGamesOnRoomDispose,
  getPendingGame,
  givePlayerTimeout,
  setPendingGame
} from "../core/pending-game-manager"
import { IGameUser } from "../models/colyseus-models/game-user"
import Player from "../models/colyseus-models/player"
import { Pokemon } from "../models/colyseus-models/pokemon"
import { BotV2 } from "../models/mongo-models/bot-v2"
import DetailledStatistic from "../models/mongo-models/detailled-statistic-v2"
import History from "../models/mongo-models/history"
import UserMetadata from "../models/mongo-models/user-metadata"
import PokemonFactory from "../models/pokemon-factory"
import {
  getPokemonData,
  PRECOMPUTED_REGIONAL_MONS
} from "../models/precomputed/precomputed-pokemon-data"
import { PRECOMPUTED_POKEMONS_PER_RARITY } from "../models/precomputed/precomputed-rarity"
import { getAdditionalsTier1 } from "../models/shop"
import {
  Emotion,
  IDragDropCombineMessage,
  IDragDropItemMessage,
  IDragDropMessage,
  IGameHistoryPokemonRecord,
  IGameHistorySimplePlayer,
  IGameMetadata,
  IPokemon,
  IPokemonEntity,
  ISimplePlayer,
  Role,
  Title,
  Transfer
} from "../types"
import {
  AdditionalPicksStages,
  ALLOWED_GAME_RECONNECTION_TIME,
  EloRank,
  EventPointsPerRank,
  ExpPlace,
  LegendaryPool,
  MAX_EVENT_POINTS,
  MAX_SIMULATION_DELTA_TIME,
  MinStageForGameToCount,
  PortalCarouselStages,
  UniquePool
} from "../types/Config"
import { CloseCodes } from "../types/enum/CloseCodes"
import { GameMode, PokemonActionState } from "../types/enum/Game"
import { Item } from "../types/enum/Item"
import { Passive } from "../types/enum/Passive"
import {
  Pkm,
  PkmDuos,
  PkmIndex,
  PkmProposition,
  PkmRegionalVariants
} from "../types/enum/Pokemon"
import { SpecialGameRule } from "../types/enum/SpecialGameRule"
import { Synergy } from "../types/enum/Synergy"
import { Wanderer } from "../types/enum/Wanderer"
import { IPokemonCollectionItemMongo } from "../types/interfaces/UserMetadata"
import { removeInArray } from "../utils/array"
import { getAvatarString } from "../utils/avatar"
import {
  getFirstAvailablePositionInBench,
  getFreeSpaceOnBench
} from "../utils/board"
import { isValidDate } from "../utils/date"
import { logger } from "../utils/logger"
import { clamp } from "../utils/number"
import { shuffleArray } from "../utils/random"
import { values } from "../utils/schemas"
import {
  OnBuyPokemonCommand,
  OnDragDropCombineCommand,
  OnDragDropItemCommand,
  OnDragDropPokemonCommand,
  OnJoinCommand,
  OnLevelUpCommand,
  OnLockCommand,
  OnPickBerryCommand,
  OnPokemonCatchCommand,
  OnRemoveFromShopCommand,
  OnSellPokemonCommand,
  OnShopRerollCommand,
  OnSpectateCommand,
  OnSwitchBenchAndBoardCommand,
  OnUpdateCommand
} from "./commands/game-commands"
import GameState from "./states/game-state"

export default class GameRoom extends Room<GameState> {
  dispatcher: Dispatcher<this>
  additionalUncommonPool: Array<Pkm>
  additionalRarePool: Array<Pkm>
  additionalEpicPool: Array<Pkm>
  miniGame: MiniGame
  constructor() {
    super()
    this.dispatcher = new Dispatcher(this)
    this.additionalUncommonPool = new Array<Pkm>()
    this.additionalRarePool = new Array<Pkm>()
    this.additionalEpicPool = new Array<Pkm>()
    this.miniGame = new MiniGame(this)
  }

  // When room is initialized
  async onCreate(options: {
    users: Record<string, IGameUser>
    preparationId: string
    name: string
    ownerName: string
    noElo: boolean
    gameMode: GameMode
    specialGameRule: SpecialGameRule | null
    minRank: EloRank | null
    maxRank: EloRank | null
    tournamentId: string | null
    bracketId: string | null
  }) {
    logger.info("Create Game ", this.roomId)

    this.onRoomDeleted = this.onRoomDeleted.bind(this)
    this.presence.subscribe("room-deleted", this.onRoomDeleted)

    this.setMetadata(<IGameMetadata>{
      name: options.name,
      ownerName: options.ownerName,
      gameMode: options.gameMode,
      playerIds: Object.keys(options.users).filter(
        (id) => options.users[id].isBot === false
      ),
      playersInfo: Object.keys(options.users).map(
        (u) => `${options.users[u].name} [${options.users[u].elo}]`
      ),
      stageLevel: 0,
      type: "game",
      tournamentId: options.tournamentId,
      bracketId: options.bracketId
    })
    // logger.debug(options);
    this.setState(
      new GameState(
        options.preparationId,
        options.name,
        options.noElo,
        options.gameMode,
        options.minRank,
        options.maxRank,
        options.specialGameRule
      )
    )
    this.miniGame.create(
      this.state.avatars,
      this.state.floatingItems,
      this.state.portals,
      this.state.symbols
    )

    this.additionalUncommonPool = getAdditionalsTier1(
      PRECOMPUTED_POKEMONS_PER_RARITY.UNCOMMON
    )
    this.additionalRarePool = getAdditionalsTier1(
      PRECOMPUTED_POKEMONS_PER_RARITY.RARE
    )
    this.additionalEpicPool = getAdditionalsTier1(
      PRECOMPUTED_POKEMONS_PER_RARITY.EPIC
    )

    shuffleArray(this.additionalUncommonPool)
    shuffleArray(this.additionalRarePool)
    shuffleArray(this.additionalEpicPool)

    if (this.state.specialGameRule === SpecialGameRule.EVERYONE_IS_HERE) {
      this.additionalUncommonPool.forEach((p) =>
        this.state.shop.addAdditionalPokemon(p)
      )
      this.additionalRarePool.forEach((p) =>
        this.state.shop.addAdditionalPokemon(p)
      )
      this.additionalEpicPool.forEach((p) =>
        this.state.shop.addAdditionalPokemon(p)
      )
    }

    await Promise.all(
      Object.keys(options.users).map(async (id) => {
        const user = options.users[id]
        //logger.debug(`init player`, user)
        if (user.isBot) {
          const player = new Player(
            user.uid,
            user.name,
            user.elo,
            user.avatar,
            true,
            this.state.players.size + 1,
            new Map<string, IPokemonCollectionItemMongo>(),
            "",
            Role.BOT,
            this.state
          )
          this.state.players.set(user.uid, player)
          this.state.botManager.addBot(player)
        } else {
          const user = await UserMetadata.findOne({ uid: id })
          if (user) {
            // init player
            const player = new Player(
              user.uid,
              user.displayName,
              user.elo,
              user.avatar,
              false,
              this.state.players.size + 1,
              user.pokemonCollection,
              user.title,
              user.role,
              this.state
            )

            this.state.players.set(user.uid, player)
            this.state.shop.assignShop(player, false, this.state)

            if (
              this.state.specialGameRule === SpecialGameRule.EVERYONE_IS_HERE
            ) {
              PRECOMPUTED_REGIONAL_MONS.forEach((p) => {
                if (getPokemonData(p).stars === 1) {
                  this.state.shop.addRegionalPokemon(p, player)
                }
              })
            }
          }
        }
      })
    )

    this.clock.setTimeout(
      () => {
        if (this.state.gameLoaded) return // already started
        this.broadcast(Transfer.LOADING_COMPLETE)
        this.state.players.forEach((player) => {
          clearPendingGame(this.presence, player.id)
        })
        this.startGame()
      },
      5 * 60 * 1000
    ) // maximum 5 minutes of loading game, game will start no matter what after that

    this.onMessage(Transfer.ITEM, (client, item: Item) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.pickItemProposition(client.auth.uid, item)
        } catch (error) {
          logger.error(error)
        }
      }
    })

    this.onMessage(Transfer.SHOP, (client, message) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnBuyPokemonCommand(), {
            playerId: client.auth.uid,
            index: message.id
          })
        } catch (error) {
          logger.error("shop error", message, error)
        }
      }
    })

    this.onMessage(Transfer.REMOVE_FROM_SHOP, (client, index) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnRemoveFromShopCommand(), {
            playerId: client.auth.uid,
            index
          })
        } catch (error) {
          logger.error("remove from shop error", index, error)
        }
      }
    })

    this.onMessage(Transfer.POKEMON_PROPOSITION, (client, pkm: Pkm) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.pickPokemonProposition(client.auth.uid, pkm)
        } catch (error) {
          logger.error(error)
        }
      }
    })

    this.onMessage(Transfer.DRAG_DROP, (client, message: IDragDropMessage) => {
      if (!this.state.gameFinished) {
        try {
          this.dispatcher.dispatch(new OnDragDropPokemonCommand(), {
            client: client,
            detail: message
          })
        } catch (error) {
          const errorInformation = {
            updateBoard: true,
            updateItems: true
          }
          client.send(Transfer.DRAG_DROP_FAILED, errorInformation)
          logger.error("drag drop error", error)
        }
      }
    })

    this.onMessage(
      Transfer.DRAG_DROP_ITEM,
      (client, message: IDragDropItemMessage) => {
        if (!this.state.gameFinished) {
          try {
            this.dispatcher.dispatch(new OnDragDropItemCommand(), {
              client: client,
              detail: message
            })
          } catch (error) {
            const errorInformation = {
              updateBoard: true,
              updateItems: true
            }
            client.send(Transfer.DRAG_DROP_FAILED, errorInformation)
            logger.error("drag drop error", error)
          }
        }
      }
    )

    this.onMessage(
      Transfer.DRAG_DROP_COMBINE,
      (client, message: IDragDropCombineMessage) => {
        if (!this.state.gameFinished) {
          try {
            this.dispatcher.dispatch(new OnDragDropCombineCommand(), {
              client: client,
              detail: message
            })
          } catch (error) {
            const errorInformation = {
              updateBoard: true,
              updateItems: true
            }
            client.send(Transfer.DRAG_DROP_FAILED, errorInformation)
            logger.error("drag drop error", error)
          }
        }
      }
    )

    this.onMessage(
      Transfer.VECTOR,
      (client, message: { x: number; y: number }) => {
        try {
          if (client.auth) {
            this.miniGame.applyVector(client.auth.uid, message.x, message.y)
          }
        } catch (error) {
          logger.error(error)
        }
      }
    )

    this.onMessage(Transfer.SELL_POKEMON, (client, pokemonId: string) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnSellPokemonCommand(), {
            client,
            pokemonId
          })
        } catch (error) {
          logger.error("sell drop error", pokemonId)
        }
      }
    })

    this.onMessage(Transfer.REFRESH, (client, message) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnShopRerollCommand(), client.auth.uid)
        } catch (error) {
          logger.error("refresh error", message)
        }
      }
    })

    this.onMessage(Transfer.LOCK, (client, message) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnLockCommand(), client.auth.uid)
        } catch (error) {
          logger.error("lock error", message)
        }
      }
    })

    this.onMessage(
      Transfer.SWITCH_BENCH_AND_BOARD,
      (client, pokemonId: string) => {
        if (!this.state.gameFinished && client.auth) {
          try {
            this.dispatcher.dispatch(new OnSwitchBenchAndBoardCommand(), {
              client,
              pokemonId
            })
          } catch (error) {
            logger.error("sell drop error", pokemonId)
          }
        }
      }
    )

    this.onMessage(Transfer.SPECTATE, (client, spectatedPlayerId: string) => {
      if (client.auth) {
        try {
          this.dispatcher.dispatch(new OnSpectateCommand(), {
            id: client.auth.uid,
            spectatedPlayerId
          })
        } catch (error) {
          logger.error("spectate error", client.auth.uid, spectatedPlayerId)
        }
      }
    })

    this.onMessage(Transfer.LEVEL_UP, (client, message) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnLevelUpCommand(), client.auth.uid)
        } catch (error) {
          logger.error("level up error", message)
        }
      }
    })

    this.onMessage(Transfer.SHOW_EMOTE, (client: Client, message?: string) => {
      if (client.auth) {
        this.broadcast(Transfer.SHOW_EMOTE, {
          id: client.auth.uid,
          emote: message
        })
      }
    })

    this.onMessage(
      Transfer.WANDERER_CAUGHT,
      async (client, msg: { id: string }) => {
        if (client.auth) {
          try {
            this.dispatcher.dispatch(new OnPokemonCatchCommand(), {
              client,
              playerId: client.auth.uid,
              id: msg.id
            })
          } catch (e) {
            logger.error("catch wandering error", e)
          }
        }
      }
    )

    this.onMessage(Transfer.PICK_BERRY, async (client, index) => {
      if (!this.state.gameFinished && client.auth) {
        try {
          this.dispatcher.dispatch(new OnPickBerryCommand(), {
            playerId: client.auth.uid,
            berryIndex: index
          })
        } catch (error) {
          logger.error("error picking berry", error)
        }
      }
    })

    this.onMessage(Transfer.LOADING_PROGRESS, (client, progress: number) => {
      if (client.auth) {
        const player = this.state.players.get(client.auth.uid)
        if (player) {
          player.loadingProgress = progress
        }
      }
    })

    this.onMessage(Transfer.LOADING_COMPLETE, (client) => {
      if (client.auth) {
        const player = this.state.players.get(client.auth.uid)
        if (player) {
          player.loadingProgress = 100
          clearPendingGame(this.presence, client.auth.uid)
        }
        if (this.state.gameLoaded) {
          // already started, presumably a user refreshed page and wants to reconnect to game
          client.send(Transfer.LOADING_COMPLETE)
        } else if (
          values(this.state.players).every((p) => p.loadingProgress === 100)
        ) {
          this.broadcast(Transfer.LOADING_COMPLETE)
          this.startGame()
        }
      }
    })
  }

  startGame() {
    if (this.state.gameLoaded) return // already started
    this.state.gameLoaded = true
    this.setSimulationInterval((deltaTime: number) => {
      /* in case of lag spikes, the game should feel slower, 
      but this max simulation dt helps preserving the correctness of simulation result */
      deltaTime = Math.min(MAX_SIMULATION_DELTA_TIME, deltaTime)
      if (!this.state.gameFinished && !this.state.simulationPaused) {
        try {
          this.dispatcher.dispatch(new OnUpdateCommand(), { deltaTime })
        } catch (error) {
          logger.error("update error", error)
        }
      }
    })
    this.state.botManager.updateBots()
    this.miniGame.initialize(this.state, this)
  }

  async onAuth(client: Client, options, context) {
    try {
      super.onAuth(client, options, context)
      const token = await admin.auth().verifyIdToken(options.idToken)
      const user = await admin.auth().getUser(token.uid)

      if (!user.displayName) {
        logger.error("No display name for this account", user.uid)
        throw new Error(
          "No display name for this account. Please report this error."
        )
      }

      return user
    } catch (error) {
      logger.error(error)
    }
  }

  async onJoin(client: Client) {
    const userProfile = await UserMetadata.findOne({ uid: client.auth.uid })
    if (userProfile?.banned) {
      throw "Account banned"
    }
    this.dispatcher.dispatch(new OnJoinCommand(), { client })
    const pendingGame = await getPendingGame(this.presence, client.auth.uid)
    if (pendingGame?.gameId === this.roomId) {
      // user reconnected without reconnection token (new browser/machine/session)
      clearPendingGame(this.presence, client.auth.uid)
    } else if (pendingGame != null && !pendingGame.isExpired) {
      client.leave(CloseCodes.USER_IN_ANOTHER_GAME)
    }
  }

  async onLeave(client: Client, consented: boolean) {
    try {
      /*if (client && client.auth && client.auth.displayName) {
        logger.info(`${client.auth.displayName} has been disconnected`)
      }*/
      if (consented) {
        throw new Error("consented leave")
      }

      // allow disconnected client to reconnect into this room until 5 minutes
      setPendingGame(this.presence, client.auth.uid, this.roomId)
      await this.allowReconnection(client, ALLOWED_GAME_RECONNECTION_TIME)
      // if the user reconnects, we clear the pending game and recall the OnJoinCommand
      clearPendingGame(this.presence, client.auth.uid)
      this.dispatcher.dispatch(new OnJoinCommand(), { client })
    } catch (e) {
      if (client && client.auth && client.auth.displayName) {
        const pendingGame = await getPendingGame(this.presence, client.auth.uid)
        if (!pendingGame && !consented)
          return // user has reconnected through other ways (new browser/machine/session)
        else if (
          pendingGame &&
          isValidDate(pendingGame.reconnectionDeadline) &&
          pendingGame.reconnectionDeadline.getTime() > Date.now()
        ) {
          // user has reconnected through other ways (new browser/machine/session) but has left or lost connection again
          // so we have a new allowed reconnection time. Ignoring this leave and relying on the onLeave call that followed
          return
        }
        clearPendingGame(this.presence, client.auth.uid)

        //logger.info(`${client.auth.displayName} left game`)
        const player = this.state.players.get(client.auth.uid)
        const hasLeftGameBeforeTheEnd =
          player && player.life > 0 && !this.state.gameFinished
        const otherHumans = values(this.state.players).filter(
          (p) => !p.isBot && p.id !== client.auth.uid
        )
        if (
          hasLeftGameBeforeTheEnd &&
          otherHumans.length >= 1 &&
          player.role !== Role.ADMIN
        ) {
          /* if a user leaves a game before the end, 
          they cannot join another in the next 5 minutes */
          givePlayerTimeout(this.presence, client.auth.uid)
        }

        if (player && this.state.stageLevel <= 5 && !consented) {
          /* 
          if player left game during the loading screen or before stage 6,
          we consider they didn't play the game and presume a technical issue
          we remove it from the players and don't give them any rewards
          */
          this.state.players.delete(client.auth.uid)
          this.setMetadata({
            playerIds: removeInArray(this.metadata.playerIds, client.auth.uid)
          })

          /*logger.info(
            `${client.auth.displayName} has been removed from players list`
          )*/
        } else if (player && !player.hasLeftGame) {
          player.hasLeftGame = true
          player.spectatedPlayerId = player.id

          const hasLeftBeforeEnd = player.life > 0 && !this.state.gameFinished
          if (hasLeftBeforeEnd) {
            // player left before being eliminated, in that case we consider this a surrender and give them the worst possible rank
            player.life = -99
            this.rankPlayers()
          }

          this.updatePlayerAfterGame(player, hasLeftBeforeEnd)
        }
      }
      if (
        !this.state.gameLoaded &&
        values(this.state.players).every((p) => p.loadingProgress === 100)
      ) {
        this.broadcast(Transfer.LOADING_COMPLETE)
        this.startGame()
      }
    }
  }

  async onDispose() {
    logger.info("Dispose Game ", this.roomId)
    this.presence.unsubscribe("room-deleted", this.onRoomDeleted)
    const players = values(this.state.players)
    players.forEach((player) => {
      clearPendingGamesOnRoomDispose(this.presence, player.id, this.roomId)
    })
    const playersAlive = players.filter((p) => p.alive)
    const humansAlive = playersAlive.filter((p) => !p.isBot)

    // we skip elo compute/game history if game is not finished
    // that is at least two players including one human are still alive
    if (playersAlive.length >= 2 && humansAlive.length >= 1) {
      if (humansAlive.length > 1) {
        // this can happen if all players disconnect before the end
        // or if there's another technical issue
        // adding a log just in case
        logger.warn(
          `Game room has been disposed while they were still ${humansAlive.length} players alive.`
        )
      }
      return // game not finished before being disposed, we skip elo compute/game history
    }

    try {
      this.state.endTime = Date.now()

      const humans: Player[] = []
      const bots: Player[] = []

      this.state.players.forEach((player) => {
        if (player.isBot) {
          bots.push(player)
        } else {
          humans.push(player)
        }
      })

      const players: ISimplePlayer[] = [...humans, ...bots].map((p) =>
        this.transformToSimplePlayer(p)
      )

      History.create({
        id: this.state.preparationId,
        name: this.state.name,
        startTime: this.state.startTime,
        endTime: this.state.endTime,
        players: humans.map((p) => this.transformToSimplePlayer(p))
      })

      if (this.state.stageLevel >= MinStageForGameToCount) {
        const elligibleToXP = this.state.players.size >= 2
        if (elligibleToXP) {
          for (let i = 0; i < bots.length; i++) {
            const botPlayer = bots[i]
            const bot = await BotV2.findOne({ id: botPlayer.id })
            if (bot) {
              bot.elo = computeElo(
                this.transformToSimplePlayer(botPlayer),
                botPlayer.rank,
                bot.elo,
                players,
                this.state.gameMode,
                true
              )
              bot.save()
            }
          }

          for (let i = 0; i < humans.length; i++) {
            const player = humans[i]
            if (!player.hasLeftGame) {
              player.hasLeftGame = true
              this.updatePlayerAfterGame(player, false)
            }
          }
        }
      }

      if (this.state.gameMode === GameMode.TOURNAMENT) {
        this.presence.publish("tournament-match-end", {
          tournamentId: this.metadata?.tournamentId,
          bracketId: this.metadata?.bracketId,
          players: humans
        })
      }

      this.dispatcher.stop()
    } catch (error) {
      logger.error(error)
    }
  }

  // when a player leaves the game
  async updatePlayerAfterGame(player: Player, hasLeftBeforeEnd: boolean) {
    // if player left before stage 10, they do not earn experience to prevent xp farming abuse
    const elligibleToXP =
      this.state.players.size >= 2 &&
      this.state.stageLevel >= MinStageForGameToCount

    const humans: Player[] = []
    const bots: Player[] = []

    this.state.players.forEach((player) => {
      if (player.isBot) {
        bots.push(player)
      } else {
        humans.push(player)
      }
    })

    const elligibleToELO =
      !this.state.noElo &&
      (this.state.stageLevel >= MinStageForGameToCount || hasLeftBeforeEnd) &&
      humans.length >= 2

    const rank = player.rank
    const exp = ExpPlace[rank - 1]

    const usr = await UserMetadata.findOne({ uid: player.id })
    if (usr) {
      if (elligibleToXP) {
        const expThreshold = 1000
        if (usr.exp + exp >= expThreshold) {
          usr.level += 1
          usr.booster += 1
          usr.exp = usr.exp + exp - expThreshold
        } else {
          usr.exp = usr.exp + exp
        }
        usr.exp = !isNaN(usr.exp) ? usr.exp : 0
      }

      usr.games += 1

      if (rank === 1) {
        usr.wins += 1
        if (this.state.gameMode === GameMode.RANKED) {
          player.titles.add(Title.VANQUISHER)
          const minElo = Math.min(
            ...values(this.state.players).map((p) => p.elo)
          )
          if (usr.elo === minElo && humans.length >= 8) {
            player.titles.add(Title.OUTSIDER)
          }
          //this.presence.publish("ranked-lobby-winner", player)
        }
      }

      if (usr.level >= 10) {
        player.titles.add(Title.ROOKIE)
      }
      if (usr.level >= 20) {
        player.titles.add(Title.AMATEUR)
        player.titles.add(Title.BOT_BUILDER)
      }
      if (usr.level >= 30) {
        player.titles.add(Title.VETERAN)
      }
      if (usr.level >= 50) {
        player.titles.add(Title.PRO)
      }
      if (usr.level >= 100) {
        player.titles.add(Title.EXPERT)
      }
      if (usr.level >= 150) {
        player.titles.add(Title.ELITE)
      }
      if (usr.level >= 200) {
        player.titles.add(Title.MASTER)
      }
      if (usr.level >= 300) {
        player.titles.add(Title.GRAND_MASTER)
      }

      if (usr.elo != null && elligibleToELO) {
        const elo = computeElo(
          this.transformToSimplePlayer(player),
          rank,
          usr.elo,
          humans.map((p) => this.transformToSimplePlayer(p)),
          this.state.gameMode,
          false
        )
        if (elo) {
          if (elo >= 1100) {
            player.titles.add(Title.GYM_TRAINER)
          }
          if (elo >= 1200) {
            player.titles.add(Title.GYM_CHALLENGER)
          }
          if (elo >= 1400) {
            player.titles.add(Title.GYM_LEADER)
          }
          usr.elo = elo
          usr.maxElo = Math.max(usr.maxElo, elo)
        }

        const dbrecord = this.transformToSimplePlayer(player)
        const synergiesMap = new Map<Synergy, number>()
        player.synergies.forEach((v, k) => {
          v > 0 && synergiesMap.set(k, v)
        })
        DetailledStatistic.create({
          time: Date.now(),
          name: dbrecord.name,
          pokemons: dbrecord.pokemons,
          rank: dbrecord.rank,
          nbplayers: humans.length + bots.length,
          avatar: dbrecord.avatar,
          playerId: dbrecord.id,
          elo: elo,
          synergies: synergiesMap,
          gameMode: this.state.gameMode
        })

        if (usr.eventFinishTime == null) {
          const eventPointsGained = EventPointsPerRank[clamp(rank - 1, 0, 7)]
          usr.eventPoints = clamp(
            usr.eventPoints + eventPointsGained,
            0,
            MAX_EVENT_POINTS
          )
          usr.maxEventPoints = Math.max(usr.maxEventPoints, usr.eventPoints)
          if (usr.maxEventPoints >= MAX_EVENT_POINTS) {
            usr.eventFinishTime = new Date()

            const finisher = await UserMetadata.findOne({
              eventFinishTime: { $ne: null }
            })
            if (!finisher) {
              player.titles.add(Title.VICTORIOUS)
              this.presence.publish(
                "announcement",
                `${player.name} won the Victory Road race !`
              )
            } else {
              this.presence.publish(
                "announcement",
                `${player.name} finished the Victory Road !`
              )
            }
            player.titles.add(Title.FINISHER)
          }

          if (usr.maxEventPoints >= 100) {
            player.titles.add(Title.RUNNER)
          }
        }
      }

      if (player.life >= 100 && rank === 1) {
        player.titles.add(Title.TYRANT)
      }
      if (player.life === 1 && rank === 1) {
        player.titles.add(Title.SURVIVOR)
      }

      if (player.rerollCount > 60) {
        player.titles.add(Title.GAMBLER)
      } else if (player.rerollCount < 20 && rank === 1) {
        player.titles.add(Title.NATURAL)
      }

      // update all pokemons played count
      player.pokemonsPlayed.forEach((pkm) => {
        const index = PkmIndex[pkm]
        const pokemonCollectionItem = usr.pokemonCollection.get(index)
        if (pokemonCollectionItem) {
          pokemonCollectionItem.played = pokemonCollectionItem.played + 1
          usr.markModified(`pokemonCollection.${index}.played`)
        } else {
          const newConfig: IPokemonCollectionItemMongo = {
            dust: 0,
            id: index,
            unlocked: Buffer.alloc(5, 0),
            selectedEmotion: null,
            selectedShiny: false,
            played: 1
          }
          usr.pokemonCollection.set(index, newConfig)
        }
      })

      if (
        player.titles.has(Title.COLLECTOR) === false &&
        Object.values(PkmIndex).every((pkmIndex) => {
          const pokemonCollectionItem = usr.pokemonCollection.get(pkmIndex)
          return pokemonCollectionItem && pokemonCollectionItem.played > 0
        })
      ) {
        player.titles.add(Title.COLLECTOR)
      }

      if (usr.titles === undefined) {
        usr.titles = []
      }

      player.titles.forEach((t) => {
        if (!usr.titles.includes(t)) {
          //logger.info("title added ", t)
          usr.titles.push(t)
        }
      })

      //logger.debug(usr);
      //usr.markModified('metadata');
      usr.save()
    }
  }

  transformToSimplePlayer(player: Player): IGameHistorySimplePlayer {
    const simplePlayer: IGameHistorySimplePlayer = {
      name: player.name,
      id: player.id,
      rank: player.rank,
      avatar: player.avatar,
      pokemons: new Array<{
        name: Pkm
        avatar: string
        items: Item[]
        inventory: Item[]
      }>(),
      elo: player.elo,
      synergies: [],
      title: player.title,
      role: player.role
    }

    player.synergies.forEach((v, k) => {
      simplePlayer.synergies.push({ name: k as Synergy, value: v })
    })

    player.board.forEach((pokemon: IPokemon) => {
      if (pokemon.positionY != 0 && pokemon.passive !== Passive.INANIMATE) {
        const avatar = getAvatarString(
          pokemon.index,
          pokemon.shiny,
          pokemon.emotion
        )
        const s: IGameHistoryPokemonRecord = {
          name: pokemon.name,
          avatar: avatar,
          items: new Array<Item>(),
          inventory: new Array<Item>()
        }
        pokemon.items.forEach((i) => {
          s.items.push(i)
          s.inventory.push(i)
        })
        simplePlayer.pokemons.push(s)
      }
    })
    return simplePlayer
  }

  spawnOnBench(player: Player, pkm: Pkm, anim: "fishing" | "spawn" = "spawn") {
    const pokemon = PokemonFactory.createPokemonFromName(pkm, player)
    const x = getFirstAvailablePositionInBench(player.board)
    if (x !== undefined) {
      pokemon.positionX = x
      pokemon.positionY = 0
      if (anim === "fishing") {
        pokemon.action = PokemonActionState.FISH
        console.log(`Spawning ${pokemon.name} on bench with fishing animation`)
      }

      player.board.set(pokemon.id, pokemon)
      this.clock.setTimeout(() => {
        pokemon.action = PokemonActionState.IDLE
        this.checkEvolutionsAfterPokemonAcquired(player.id)
      }, 1000)
    }
  }

  checkEvolutionsAfterPokemonAcquired(playerId: string): boolean {
    const player = this.state.players.get(playerId)
    if (!player) return false
    let hasEvolved = false

    player.board.forEach((pokemon) => {
      if (
        pokemon.hasEvolution &&
        pokemon.evolutionRule instanceof CountEvolutionRule
      ) {
        const pokemonEvolved = pokemon.evolutionRule.tryEvolve(
          pokemon,
          player,
          this.state.stageLevel
        )
        if (pokemonEvolved) {
          hasEvolved = true
        }
      }
    })

    player.boardSize = this.getTeamSize(player.board)
    return hasEvolved
  }

  checkEvolutionsAfterItemAcquired(
    playerId: string,
    pokemon: Pokemon
  ): Pokemon | void {
    const player = this.state.players.get(playerId)
    if (!player) return

    if (
      pokemon.evolutionRule &&
      pokemon.evolutionRule instanceof ItemEvolutionRule
    ) {
      const pokemonEvolved = pokemon.evolutionRule.tryEvolve(
        pokemon,
        player,
        this.state.stageLevel
      )
      return pokemonEvolved
    }
  }

  getNumberOfPlayersAlive(players: MapSchema<Player>) {
    let numberOfPlayersAlive = 0
    players.forEach((player, key) => {
      if (player.alive) {
        numberOfPlayersAlive++
      }
    })
    return numberOfPlayersAlive
  }

  getTeamSize(board: MapSchema<Pokemon>) {
    let size = 0

    board.forEach((pokemon, key) => {
      if (pokemon.positionY != 0 && pokemon.doesCountForTeamSize) {
        size++
      }
    })

    return size
  }

  pickPokemonProposition(
    playerId: string,
    pkm: PkmProposition,
    bypassLackOfSpace = false
  ) {
    const player = this.state.players.get(playerId)
    if (!player || player.pokemonsProposition.length === 0) return
    if (this.state.additionalPokemons.includes(pkm as Pkm)) return // already picked, probably a double click
    if (
      UniquePool.includes(pkm) &&
      this.state.stageLevel !== PortalCarouselStages[1]
    )
      return // should not be pickable at this stage
    if (
      LegendaryPool.includes(pkm) &&
      this.state.stageLevel !== PortalCarouselStages[2]
    )
      return // should not be pickable at this stage

    const pokemonsObtained: Pokemon[] = (
      pkm in PkmDuos ? PkmDuos[pkm] : [pkm]
    ).map((p) => PokemonFactory.createPokemonFromName(p, player))

    const freeSpace = getFreeSpaceOnBench(player.board)
    if (freeSpace < pokemonsObtained.length && !bypassLackOfSpace) return // prevent picking if not enough space on bench

    // at this point, the player is allowed to pick a proposition
    const selectedIndex = player.pokemonsProposition.indexOf(pkm)
    player.pokemonsProposition.clear()

    if (AdditionalPicksStages.includes(this.state.stageLevel)) {
      // If player picked their regional variant, we need to add the base pokemon to the shop pool
      if (pokemonsObtained[0]?.regional) {
        const basePkm = (Object.keys(PkmRegionalVariants).find((p) =>
          PkmRegionalVariants[p].includes(pokemonsObtained[0].name)
        ) ?? pokemonsObtained[0].name) as Pkm
        this.state.additionalPokemons.push(basePkm)
        this.state.shop.addAdditionalPokemon(basePkm)
        player.regionalPokemons.push(pkm as Pkm)
      } else {
        this.state.additionalPokemons.push(pkm as Pkm)
        this.state.shop.addAdditionalPokemon(pkm)
      }

      // update regional pokemons in case some regional variants of add picks are now available
      this.state.players.forEach((p) => p.updateRegionalPool(this.state, false))

      const selectedItem = player.itemsProposition[selectedIndex]
      if (player.itemsProposition.length > 0 && selectedItem != null) {
        player.items.push(selectedItem)
        player.itemsProposition.clear()
      }
    }

    if (
      this.state.specialGameRule === SpecialGameRule.FIRST_PARTNER &&
      this.state.stageLevel <= 1
    ) {
      player.firstPartner = pokemonsObtained[0].name
    }

    pokemonsObtained.forEach((pokemon) => {
      const freeCellX = getFirstAvailablePositionInBench(player.board)
      if (freeCellX !== undefined) {
        pokemon.positionX = freeCellX
        pokemon.positionY = 0
        player.board.set(pokemon.id, pokemon)
        pokemon.onAcquired(player)
      }
    })
  }

  pickItemProposition(playerId: string, item: Item) {
    const player = this.state.players.get(playerId)
    if (player && player.itemsProposition.includes(item)) {
      player.items.push(item)
      player.itemsProposition.clear()
    }
  }

  computeRoundDamage(
    opponentTeam: MapSchema<IPokemonEntity>,
    stageLevel: number
  ) {
    let damage = Math.ceil(stageLevel / 2)
    if (opponentTeam.size > 0) {
      opponentTeam.forEach((pokemon) => {
        if (!pokemon.isSpawn && pokemon.passive !== Passive.INANIMATE) {
          damage += 1
        }
      })
    }
    return damage
  }

  rankPlayers() {
    const rankArray = new Array<{ id: string; life: number; level: number }>()
    this.state.players.forEach((player) => {
      if (!player.alive) {
        return
      }

      rankArray.push({
        id: player.id,
        life: player.life,
        level: player.experienceManager.level
      })
    })

    const sortPlayers = (
      a: { id: string; life: number; level: number },
      b: { id: string; life: number; level: number }
    ) => {
      let diff = b.life - a.life
      if (diff == 0) {
        diff = b.level - a.level
      }
      return diff
    }

    rankArray.sort(sortPlayers)

    rankArray.forEach((rankPlayer, index) => {
      const player = this.state.players.get(rankPlayer.id)
      if (player) {
        player.rank = index + 1
      }
    })
  }

  onRoomDeleted(roomId) {
    if (this.roomId === roomId) {
      this.disconnect(CloseCodes.ROOM_DELETED)
    }
  }

  spawnWanderingPokemon(wandererNoId: Omit<Wanderer, "id">, player: Player) {
    const client = this.clients.find((cli) => cli.auth.uid === player.id)
    if (!client) return
    const id = nanoid()
    const wanderer: Wanderer = { ...wandererNoId, id }
    this.state.wanderers.set(id, wanderer)
    client.send(Transfer.WANDERER, wanderer)
  }
}
