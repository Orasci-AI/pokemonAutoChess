import { Room } from "colyseus.js"
import { t } from "i18next"
import Phaser from "phaser"
import MoveToPlugin from "phaser3-rex-plugins/plugins/moveto-plugin.js"
import OutlinePlugin from "phaser3-rex-plugins/plugins/outlinepipeline-plugin.js"
import React from "react"
import { toast } from "react-toastify"
import { PokemonEntity } from "../../../core/pokemon-entity"
import Simulation from "../../../core/simulation"
import Count from "../../../models/colyseus-models/count"
import { FloatingItem } from "../../../models/colyseus-models/floating-item"
import Player from "../../../models/colyseus-models/player"
import { Pokemon } from "../../../models/colyseus-models/pokemon"
import { PokemonAvatarModel } from "../../../models/colyseus-models/pokemon-avatar"
import { Portal, SynergySymbol } from "../../../models/colyseus-models/portal"
import Status from "../../../models/colyseus-models/status"
import GameState from "../../../rooms/states/game-state"
import {
  IDragDropCombineMessage,
  IDragDropItemMessage,
  IDragDropMessage,
  IPlayer,
  IPokemon,
  IPokemonEntity,
  Transfer
} from "../../../types"
import { Ability } from "../../../types/enum/Ability"
import {
  AttackType,
  GamePhaseState,
  HealType,
  Orientation,
  PokemonActionState,
  Rarity
} from "../../../types/enum/Game"
import { Weather } from "../../../types/enum/Weather"
import type { NonFunctionPropNames } from "../../../types/HelperTypes"
import { logger } from "../../../utils/logger"
import { clamp, max } from "../../../utils/number"
import { values } from "../../../utils/schemas"
import { getCachedPortrait } from "../pages/component/game/game-pokemon-portrait"
import { playSound, SOUNDS } from "../pages/utils/audio"
import { transformBoardCoordinates } from "../pages/utils/utils"
import { preference, subscribeToPreferences } from "../preferences"
import store from "../stores"
import { changePlayer, setPlayer, setSimulation } from "../stores/GameStore"
import { BoardMode } from "./components/board-manager"
import { DEPTH } from "./depths"
import GameScene from "./scenes/game-scene"

class GameContainer {
  room: Room<GameState>
  div: HTMLDivElement
  game: Phaser.Game | undefined
  player: Player | undefined
  simulation: Simulation | undefined
  uid: string
  spectate: boolean
  constructor(div: HTMLDivElement, uid: string, room: Room<GameState>) {
    this.room = room
    this.div = div
    this.uid = uid
    this.spectate = false
    this.initializeEvents()
  }

  resetSimulation() {
    this.simulation = undefined
    this.gameScene?.battle?.clear()
  }

  initializeSimulation(simulation: Simulation) {
    if (
      simulation.bluePlayerId === this.player?.id ||
      (simulation.redPlayerId === this.player?.id && !simulation.isGhostBattle)
    ) {
      this.setSimulation(simulation)
    }

    simulation.listen("winnerId", (winnerId) => {
      if (this.gameScene?.board?.player.simulationId === simulation.id) {
        this.gameScene.board.victoryAnimation(winnerId)
      }
    })

    simulation.listen("weather", (value, previousValue) => {
      this.handleWeatherChange(simulation, value)
    })

    for (const team of [simulation.blueTeam, simulation.redTeam]) {
      team.onAdd((p, key) =>
        this.initializePokemon(<PokemonEntity>p, simulation)
      )
      team.onRemove((pokemon, key) => {
        // logger.debug('remove pokemon');
        this.gameScene?.battle?.removePokemon(simulation.id, pokemon)
      })
    }

    simulation.listen("started", (value, previousValue) => {
      if (
        this.gameScene?.board?.player.simulationId === simulation.id &&
        value === true &&
        value !== previousValue
      ) {
        this.gameScene?.board?.removePokemonsOnBoard(false)
        this.gameScene?.battle?.onSimulationStart()
      }
    })
  }

  initializePokemon(pokemon: PokemonEntity, simulation: Simulation) {
    this.gameScene?.battle?.addPokemonEntitySprite(simulation.id, pokemon)
    const fields: NonFunctionPropNames<Status>[] = [
      "armorReduction",
      "burn",
      "charm",
      "confusion",
      "curse",
      "curseVulnerability",
      "curseWeakness",
      "curseTorment",
      "curseFate",
      "electricField",
      "fairyField",
      "fatigue",
      "flinch",
      "freeze",
      "grassField",
      "paralysis",
      "pokerus",
      "poisonStacks",
      "protect",
      "skydiving",
      "psychicField",
      "resurection",
      "resurecting",
      "runeProtect",
      "silence",
      "sleep",
      "spikeArmor",
      "wound",
      "enraged",
      "possessed",
      "locked",
      "blinded",
      "magicBounce",
      "reflect",
      "tree"
    ]

    fields.forEach((field) => {
      pokemon.status.listen(field, (value, previousValue) => {
        this.gameScene?.battle?.changeStatus(
          simulation.id,
          pokemon,
          field,
          previousValue
        )
      })
    })

    pokemon.onChange(() => {
      const fields: (NonFunctionPropNames<PokemonEntity> &
        keyof IPokemonEntity)[] = [
          "positionX",
          "positionY",
          "orientation",
          "action",
          "critChance",
          "critPower",
          "ap",
          "luck",
          "speed",
          "life",
          "hp",
          "shield",
          "pp",
          "atk",
          "def",
          "speDef",
          "range",
          "targetX",
          "targetY",
          "team",
          "index",
          "shiny",
          "skill",
          "stars",
          "types"
        ]

      fields.forEach((field) => {
        pokemon.listen(field, (value, previousValue) => {
          this.gameScene?.battle?.changePokemon(
            simulation.id,
            pokemon,
            field,
            value,
            previousValue || value
          )
        })
      })
    })

    pokemon.items.onChange((value, key) => {
      this.gameScene?.battle?.updatePokemonItems(simulation.id, pokemon)
    })

    const fieldsCount: NonFunctionPropNames<Count>[] = [
      "crit",
      "dodgeCount",
      "ult",
      "fieldCount",
      "fightingBlockCount",
      "fairyCritCount",
      "powerLensCount",
      "starDustCount",
      "spellBlockedCount",
      "manaBurnCount",
      "moneyCount",
      "amuletCoinCount",
      "bottleCapCount",
      "attackCount",
      "tripleAttackCount",
      "upgradeCount",
      "soulDewCount",
      "defensiveRibbonCount",
      "magmarizerCount"
    ]

    fieldsCount.forEach((field) => {
      pokemon.count.listen(field, (value, previousValue) => {
        this.gameScene?.battle?.changeCount(
          simulation.id,
          pokemon,
          field,
          value,
          previousValue
        )
      })
    })
  }

  initializeGame() {
    if (this.game != null) return // prevent initializing twice
    // Create Phaser game
    const renderer = Number(preference("renderer") ?? Phaser.AUTO)
    const config = {
      type: renderer,
      width: 1950,
      height: 1000,
      parent: this.div,
      pixelArt: true,
      scene: GameScene,
      scale: { mode: Phaser.Scale.FIT },
      dom: {
        createContainer: true
      },
      disableContextMenu: true,
      plugins: {
        global: [
          {
            key: "rexMoveTo",
            plugin: MoveToPlugin,
            start: true
          }
        ]
      }
    }
    this.game = new Phaser.Game(config)
    this.game.domContainer.style.zIndex = DEPTH.PHASER_DOM_CONTAINER.toString()
    this.game.scene.start("gameScene", {
      room: this.room,
      spectate: this.spectate
    })
    this.game.scale.on("resize", this.resize, this)
    if (this.game.renderer.type === Phaser.WEBGL) {
      this.game.plugins.install("rexOutline", OutlinePlugin, true)
    }
    const unsubscribeToPreferences = subscribeToPreferences(
      ({ antialiasing }) => {
        if (!this.game?.canvas) return
        this.game.canvas.style.imageRendering = antialiasing ? "" : "pixelated"
      },
      true
    )
    this.game.events.on("destroy", unsubscribeToPreferences)
  }

  resize() {
    const screenWidth = window.innerWidth - 60
    const screenHeight = window.innerHeight
    const screenRatio = screenWidth / screenHeight
    const IDEAL_WIDTH = 42 * 48
    const MIN_HEIGHT = 1050
    const MAX_HEIGHT = 32 * 48
    const height = clamp(IDEAL_WIDTH / screenRatio, MIN_HEIGHT, MAX_HEIGHT)
    const width = max(50 * 48)(height * screenRatio)

    if (
      this.game &&
      (this.game.scale.height !== height || this.game.scale.width !== width)
    ) {
      this.game.scale.setGameSize(width, height)
    }
  }

  initializeEvents() {
    this.room.onMessage(Transfer.DRAG_DROP_FAILED, (message) =>
      this.handleDragDropFailed(message)
    )
    this.room.state.avatars.onAdd((avatar) => {
      this.gameScene?.minigameManager?.addPokemon(avatar)
      const fields: NonFunctionPropNames<PokemonAvatarModel>[] = [
        "x",
        "y",
        "action",
        "timer",
        "orientation"
      ]
      fields.forEach((field) => {
        avatar.listen(field, (value, previousValue) => {
          this.gameScene?.minigameManager?.changePokemon(avatar, field, value)
        })
      })
    })

    this.room.state.avatars.onRemove((avatar, key) => {
      this.gameScene?.minigameManager?.removePokemon(avatar)
    })

    this.room.state.floatingItems.onAdd((floatingItem) => {
      this.gameScene?.minigameManager?.addItem(floatingItem)
      const fields: NonFunctionPropNames<FloatingItem>[] = [
        "x",
        "y",
        "avatarId"
      ]

      fields.forEach((field) => {
        floatingItem.listen(field, (value, previousValue) => {
          this.gameScene?.minigameManager?.changeItem(
            floatingItem,
            field,
            value
          )
        })
      })
    })

    this.room.state.floatingItems.onRemove((floatingItem, key) => {
      this.gameScene?.minigameManager?.removeItem(floatingItem)
    })

    this.room.state.portals.onAdd((portal) => {
      this.gameScene?.minigameManager?.addPortal(portal)
      const fields: NonFunctionPropNames<Portal>[] = ["x", "y", "avatarId"]

      fields.forEach((field) => {
        portal.listen(field, (value, previousValue) => {
          this.gameScene?.minigameManager?.changePortal(portal, field, value)
        })
      })
    })

    this.room.state.portals.onRemove((portal, key) => {
      this.gameScene?.minigameManager?.removePortal(portal)
    })

    this.room.state.symbols.onAdd((symbol) => {
      this.gameScene?.minigameManager?.addSymbol(symbol)
      const fields: NonFunctionPropNames<SynergySymbol>[] = [
        "x",
        "y",
        "portalId"
      ]

      fields.forEach((field) => {
        symbol.listen(field, (value, previousValue) => {
          this.gameScene?.minigameManager?.changeSymbol(symbol, field, value)
        })
      })
    })

    this.room.state.symbols.onRemove((symbol, key) => {
      this.gameScene?.minigameManager?.removeSymbol(symbol)
    })

    this.room.onError((err) => logger.error("room error", err))
  }

  initializePlayer(player: Player) {
    //logger.debug("initializePlayer", player, player.id)
    if (this.uid == player.id || (this.spectate && !this.player)) {
      this.room.send(Transfer.SPECTATE, this.uid) // always spectate yourself when loading the game initially
      this.setPlayer(player)
      this.initializeGame()
    }

    const listenForPokemonChanges = (pokemon: Pokemon) => {
      pokemon.onChange(() => {
        const fields: NonFunctionPropNames<IPokemon>[] = [
          "positionX",
          "positionY",
          "action",
          "hp",
          "atk",
          "ap",
          "def",
          "speed",
          "shiny",
          "skill",
          "meal"
        ]
        fields.forEach((field) => {
          pokemon.listen(field, (value, previousValue) => {
            if (field && player.id === this.spectatedPlayerId) {
              this.gameScene?.board?.changePokemon(
                pokemon,
                field,
                value as IPokemon[typeof field],
                previousValue as IPokemon[typeof field]
              )
            }
          })
        })

        pokemon.types.onChange((value, key) => {
          if (player.id === this.spectatedPlayerId) {
            const pokemonUI = this.gameScene?.board?.pokemons.get(pokemon.id)
            if (pokemonUI) {
              pokemonUI.types = new Set(values(pokemon.types))
            }
          }
        })

        pokemon.items.onChange((value, key) => {
          if (player.id === this.spectatedPlayerId) {
            this.gameScene?.board?.updatePokemonItems(player.id, pokemon, value)
          }
        })
      })
    }

    player.board.onAdd((pokemon, key) => {
      if (pokemon.stars > 1) {
        const i = React.createElement(
          "img",
          {
            src: getCachedPortrait(pokemon.index, player.pokemonCustoms)
          },
          null
        )
        toast(i, {
          containerId: player.rank.toString(),
          className: "toast-new-pokemon"
        })
      }

      listenForPokemonChanges(pokemon)

      this.handleBoardPokemonAdd(player, pokemon)
    }, false)

    player.board.onRemove((pokemon, key) => {
      if (player.id === this.spectatedPlayerId) {
        this.gameScene?.board?.removePokemon(pokemon)
      }
    })

    player.board.onChange((pokemon, key) => {
      store.dispatch(
        changePlayer({ id: player.id, field: "board", value: player.board })
      )
      if (pokemon) {
        listenForPokemonChanges(pokemon)
      }
    })

    player.items.onChange((value, key) => {
      if (player.id === this.spectatedPlayerId) {
        //logger.debug("changed", value, key, player.items)
        this.gameScene?.itemsContainer?.render(player.items)
      }
    })

    player.synergies.onChange(() => {
      if (player.id === this.spectatedPlayerId) {
        this.gameScene?.board?.showLightCell()
        this.gameScene?.board?.showBerryTrees()
      }
    })
  }

  initializeSpectactor(uid: string) {
    if (this.uid === uid) {
      this.spectate = true
      if (this.room.state.players.size > 0) {
        this.initializeGame()
      }
    }
  }

  get gameScene(): GameScene | undefined {
    return this.game?.scene?.getScene("gameScene") as GameScene | undefined
  }

  get spectatedPlayerId(): string {
    return store.getState().game.currentPlayerId
  }

  get simulationId(): string {
    return this.simulation?.id ? this.simulation.id : ""
  }

  handleWeatherChange(simulation: Simulation, value: Weather) {
    if (this.gameScene && simulation.id === this.player?.simulationId) {
      if (this.gameScene.weatherManager) {
        this.gameScene.weatherManager.clearWeather()
        if (value === Weather.RAIN) {
          this.gameScene.weatherManager.addRain()
        } else if (value === Weather.SUN) {
          this.gameScene.weatherManager.addSun()
        } else if (value === Weather.SANDSTORM) {
          this.gameScene.weatherManager.addSandstorm()
        } else if (value === Weather.SNOW) {
          this.gameScene.weatherManager.addSnow()
        } else if (value === Weather.NIGHT) {
          this.gameScene.weatherManager.addNight()
        } else if (value === Weather.BLOODMOON) {
          this.gameScene.weatherManager.addBloodMoon()
        } else if (value === Weather.WINDY) {
          this.gameScene.weatherManager.addWind()
        } else if (value === Weather.STORM) {
          this.gameScene.weatherManager.addStorm()
        } else if (value === Weather.MISTY) {
          this.gameScene.weatherManager.addMist()
        } else if (value === Weather.SMOG) {
          this.gameScene.weatherManager.addSmog()
        }
      }
    }
  }

  handleDisplayHeal(message: {
    type: HealType
    id: string
    x: number
    y: number
    index: string
    amount: number
  }) {
    if (document.hidden) return // do not display heal when the tab is not focused
    this.gameScene?.battle?.displayHeal(
      message.x,
      message.y,
      message.amount,
      message.type,
      message.index,
      message.id
    )
  }

  handleDisplayDamage(message: {
    type: AttackType
    id: string
    x: number
    y: number
    index: string
    amount: number
  }) {
    if (document.hidden) return // do not display damage when the tab is not focused
    if (preference("showDamageNumbers")) {
      this.gameScene?.battle?.displayDamage(
        message.x,
        message.y,
        message.amount,
        message.type,
        message.index,
        message.id
      )
    }
  }

  handleDisplayAbility(message: {
    id: string
    skill: Ability
    orientation: Orientation
    positionX: number
    positionY: number
    targetX?: number
    targetY?: number
    delay?: number
  }) {
    if (document.hidden) return // do not display abilities when the tab is not focused
    this.gameScene?.battle?.displayAbility(
      message.id,
      message.skill,
      message.orientation,
      message.positionX,
      message.positionY,
      message.targetX,
      message.targetY,
      message.delay
    )
  }

  /* Board pokemons */

  handleBoardPokemonAdd(player: IPlayer, pokemon: IPokemon) {
    const board = this.gameScene?.board
    if (
      board &&
      player.id === this.spectatedPlayerId &&
      (board.mode === BoardMode.PICK || pokemon.positionY === 0)
    ) {
      const pokemonUI = this.gameScene?.board?.addPokemonSprite(pokemon)
      if (pokemonUI && pokemon.action === PokemonActionState.FISH) {
        pokemonUI.fishingAnimation()
      } else if (pokemonUI && pokemon.stars > 1) {
        pokemonUI.evolutionAnimation()
        playSound(
          pokemon.stars === 2 ? SOUNDS.EVOLUTION_T2 : SOUNDS.EVOLUTION_T3
        )
      } else if (pokemonUI && pokemon.rarity === Rarity.HATCH) {
        pokemonUI.hatchAnimation()
      } else if (pokemonUI) {
        pokemonUI.spawnAnimation()
      }
    }
  }

  handleDragDropFailed(message: {
    updateBoard: boolean
    updateItems: boolean
    text?: string
    pokemonId?: string
  }) {
    const gameScene = this.gameScene
    if (gameScene?.lastDragDropPokemon && message.updateBoard) {
      const tg = gameScene.lastDragDropPokemon
      const coordinates = transformBoardCoordinates(tg.positionX, tg.positionY)
      tg.x = coordinates[0]
      tg.y = coordinates[1]
    }

    if (message.updateItems && gameScene && this.player) {
      gameScene.itemsContainer?.render(this.player.items)
    }

    if (message.text && message.pokemonId) {
      const pokemon = this.player?.board.get(message.pokemonId)
      if (pokemon) {
        const [x, y] = transformBoardCoordinates(
          pokemon.positionX,
          pokemon.positionY
        )
        gameScene?.board?.displayText(x, y, t(message.text))
      }
    }
  }

  setPlayer(player: Player) {
    this.player = player
    if (this.room.state.phase !== GamePhaseState.TOWN) {
      this.gameScene?.setMap(player.map)
    }
    this.gameScene?.battle?.setPlayer(player)
    this.gameScene?.board?.setPlayer(player)
    this.gameScene?.itemsContainer?.setPlayer(player)
    store.dispatch(setPlayer(player))
  }

  setSimulation(simulation: Simulation) {
    this.simulation = simulation
    store.dispatch(setSimulation(simulation))
    if (this.gameScene?.battle) {
      this.gameScene?.battle.setSimulation(this.simulation)
    }
    this.handleWeatherChange(simulation, simulation.weather)
  }

  onDragDrop(event: CustomEvent<IDragDropMessage>) {
    this.room.send(Transfer.DRAG_DROP, event.detail)
  }

  onDragDropCombine(event: CustomEvent<IDragDropCombineMessage>) {
    this.room.send(Transfer.DRAG_DROP_COMBINE, event.detail)
  }

  onDragDropItem(event: CustomEvent<IDragDropItemMessage>) {
    this.room.send(Transfer.DRAG_DROP_ITEM, event.detail)
  }
}

export default GameContainer
